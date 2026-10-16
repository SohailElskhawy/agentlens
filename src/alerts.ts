import type { DB } from './db.ts';
import { getSetting } from './db.ts';
import { sendDesktopNotification } from './report-scheduler.ts';
import { computeQuotaForecasts } from './quota-forecast.ts';
import { detectRetryLoops } from './analyze/retry_loop.ts';

// In-memory debounce cache: key -> timestamp last notified
const alertDebounce = new Map<string, number>();
const DEBOUNCE_COOLDOWN_MS = 3600_000; // 1 hour per session + rule

export interface AlertOptions {
  now?: number;
  notifier?: (title: string, body: string) => boolean;
}

export interface FiredAlert {
  type: 'retry_loop' | 'quota_forecast' | 'budget';
  key: string;
  title: string;
  body: string;
}

export function clearAlertDebounceCache(): void {
  alertDebounce.clear();
}

/**
 * Checks for live alerts during serve and sends desktop notifications if triggered and not debounced.
 */
export function checkLiveAlerts(db: DB, options: AlertOptions = {}): FiredAlert[] {
  const now = options.now ?? Date.now();
  const notify = options.notifier ?? sendDesktopNotification;
  const firedAlerts: FiredAlert[] = [];

  // 1. Retry Loop Alert
  const retryLoopEnabled = getSetting(db, 'alert_retry_loop', 'true') !== 'false';
  if (retryLoopEnabled) {
    try {
      const loops = detectRetryLoops(db);
      // Check for active sessions within the last 30 minutes
      const thirtyMinutesAgo = now - 30 * 60_000;
      for (const finding of loops) {
        if (!finding.sessionId) continue;
        const key = `retry_loop:${finding.sessionId}`;
        const lastSent = alertDebounce.get(key) ?? 0;
        if (now - lastSent < DEBOUNCE_COOLDOWN_MS) continue;

        // Check if session had activity recently
        const recentEvt = db.prepare('SELECT ts FROM events WHERE session_id = ? AND ts >= ? LIMIT 1').get(finding.sessionId, thirtyMinutesAgo);
        if (!recentEvt) continue;

        const tool = finding.evidence?.tool || 'tool';
        const count = finding.evidence?.count ? ` (${finding.evidence.count}x)` : '';
        const title = 'agentlens: Retry Loop Detected';
        const body = `Session ${finding.sessionId.slice(0, 8)} is repeatedly failing '${tool}'${count}.`;

        alertDebounce.set(key, now);
        notify(title, body);
        firedAlerts.push({ type: 'retry_loop', key, title, body });
      }
    } catch {}
  }

  // 2. Quota Forecast Alert (within 30 minutes of 100% exhaustion)
  const quotaForecastEnabled = getSetting(db, 'alert_quota_forecast', 'true') !== 'false';
  if (quotaForecastEnabled) {
    try {
      const forecasts = computeQuotaForecasts(db);
      for (const fc of forecasts) {
        if (!fc.willExhaustBeforeReset || !fc.projectedExhaustionTs) continue;
        const msUntilExhaustion = fc.projectedExhaustionTs - now;

        // Fire if exhaustion projected within 30 minutes
        if (msUntilExhaustion > 0 && msUntilExhaustion <= 30 * 60_000) {
          const key = `quota_forecast:${fc.agent}:${fc.window}:${fc.resetsAt}`;
          const lastSent = alertDebounce.get(key) ?? 0;
          if (now - lastSent < DEBOUNCE_COOLDOWN_MS) continue;

          const minsLeft = Math.max(1, Math.round(msUntilExhaustion / 60_000));
          const title = 'agentlens: Quota Exhaustion Warning';
          const body = `${fc.agent.toUpperCase()} ${fc.window} quota projected to hit 100% in ~${minsLeft}m (${fc.message}).`;

          alertDebounce.set(key, now);
          notify(title, body);
          firedAlerts.push({ type: 'quota_forecast', key, title, body });
        }
      }
    } catch {}
  }

  // 3. Project Budget Alert (80% or 100% threshold)
  const budgetAlertEnabled = getSetting(db, 'alert_budget', 'true') !== 'false';
  if (budgetAlertEnabled) {
    try {
      // Find all projects with weekly token or cost budgets configured
      const settings = db.prepare(`SELECT key, value FROM settings WHERE key LIKE 'budget_tokens_%' OR key LIKE 'budget_cost_%'`).all() as Array<{ key: string; value: string }>;
      const sevenDaysAgo = now - 7 * 86400_000;

      for (const s of settings) {
        const isTokens = s.key.startsWith('budget_tokens_');
        const projIdStr = s.key.replace(isTokens ? 'budget_tokens_' : 'budget_cost_', '');
        const projId = Number(projIdStr);
        const budgetLimit = Number(s.value);
        if (!projId || !budgetLimit || budgetLimit <= 0) continue;

        const proj = db.prepare('SELECT name FROM projects WHERE id = ?').get(projId) as { name: string } | undefined;
        if (!proj) continue;

        // Compute current 7-day tokens for project
        const row = db.prepare(`
          SELECT coalesce(sum(e.input + e.output + e.cache_read + e.cache_write), 0) AS tokens
          FROM events e
          JOIN sessions s ON s.id = e.session_id
          WHERE s.project_id = ? AND e.ts >= ?
        `).get(projId, sevenDaysAgo) as { tokens: number };

        const currentVal = row.tokens;
        const pctUsed = (currentVal / budgetLimit) * 100;

        if (pctUsed >= 100) {
          const key = `budget:${projId}:100`;
          const lastSent = alertDebounce.get(key) ?? 0;
          if (now - lastSent >= DEBOUNCE_COOLDOWN_MS) {
            const title = 'agentlens: Project Budget Exceeded';
            const body = `Project '${proj.name}' has exceeded 100% of its weekly token budget (${Math.round(pctUsed)}% used).`;
            alertDebounce.set(key, now);
            notify(title, body);
            firedAlerts.push({ type: 'budget', key, title, body });
          }
        } else if (pctUsed >= 80) {
          const key = `budget:${projId}:80`;
          const lastSent = alertDebounce.get(key) ?? 0;
          if (now - lastSent >= DEBOUNCE_COOLDOWN_MS) {
            const title = 'agentlens: Project Budget Alert';
            const body = `Project '${proj.name}' reached ${Math.round(pctUsed)}% of its weekly token budget.`;
            alertDebounce.set(key, now);
            notify(title, body);
            firedAlerts.push({ type: 'budget', key, title, body });
          }
        }
      }
    } catch {}
  }

  return firedAlerts;
}
