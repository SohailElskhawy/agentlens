import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import type { DB } from './db.ts';
import { generateWeeklyReport, getIsoWeekString } from './report.ts';
import { getPlatformPaths } from './paths.ts';

export function sendDesktopNotification(title: string, body: string): boolean {
  try {
    const p = spawn('notify-send', [title, body], {
      stdio: 'ignore',
      detached: true,
    });
    p.on('error', () => {});
    p.unref();
    return true;
  } catch {
    return false;
  }
}

export function checkWeeklyReportSchedule(
  db: DB,
  home: string,
  now = Date.now()
): { generated: boolean; week?: string; path?: string } {
  const d = new Date(now);
  const dayOfWeek = d.getUTCDay(); // 0 = Sunday, 1 = Monday
  const hour = d.getUTCHours();

  // If it's Monday before 09:00 UTC or Sunday, do not trigger previous week report yet
  if (dayOfWeek === 0 || (dayOfWeek === 1 && hour < 9)) {
    return { generated: false };
  }

  // Previous closed week (7 days ago)
  const targetWeek = getIsoWeekString(now - 7 * 86_400_000);
  const reportsDir = getPlatformPaths(home).reportsDir;
  const reportPath = join(reportsDir, `${targetWeek}.md`);

  if (!existsSync(reportPath)) {
    const report = generateWeeklyReport(db, targetWeek, home);
    sendDesktopNotification(
      'agentlens Weekly Report',
      `Weekly usage report for ${targetWeek} is ready.`
    );
    return { generated: true, week: targetWeek, path: report.filePathMd };
  }

  return { generated: false, week: targetWeek, path: reportPath };
}
