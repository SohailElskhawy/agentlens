import type { DB } from './db.ts';
import { summary } from './queries.ts';

export interface SubscriptionComparisonOptions { plan?: string; days?: number; now?: number }
export const PLAN_PRICES_AS_OF = '2026-10-30';
const PLAN_PRICES: Record<string, number> = { pro: 20, max5x: 100, max20x: 200 };
const DISCLOSURE = 'Local Claude logs may include API-billed usage and omit web chat and other machines. This is not actual subscription utilization or measured value. US monthly list prices exclude taxes; annual and regional pricing are unsupported. The N/30 reference is illustrative, not an invoice. Conditional API credit benefits are excluded.';

export function subscriptionComparison(db: DB, { plan = 'pro', days = 30, now = Date.now() }: SubscriptionComparisonOptions = {}) {
  if (plan.toLowerCase() === 'team') throw new Error('Team plans are unsupported');
  if (!Object.hasOwn(PLAN_PRICES, plan)) throw new Error('plan must be pro, max5x, or max20x');
  if (!Number.isSafeInteger(days) || days < 1 || days > 365) throw new Error('days must be an integer from 1 to 365');
  const from = now - days * 86400_000;
  const { totals, pricesAsOf } = summary(db, { agent: 'claude', from, to: now });
  const pricedTokens = totals.tokens - totals.unpricedTokens;
  const monthlyPlanPriceUsd = PLAN_PRICES[plan];
  const periodPlanPriceUsd = monthlyPlanPriceUsd * days / 30;
  return {
    title: 'Estimated API/list-price comparison', plan, days, from, to: now,
    tokens: totals.tokens, unpricedTokens: totals.unpricedTokens,
    tokenCoverage: totals.tokens ? pricedTokens / totals.tokens : null,
    estimatedApiCostUsd: totals.cost, monthlyPlanPriceUsd, periodPlanPriceUsd,
    estimatedRatio: pricedTokens > 0 ? totals.cost / periodPlanPriceUsd : null,
    tokenPricesAsOf: pricesAsOf, planPricesAsOf: PLAN_PRICES_AS_OF,
    planPriceSource: 'https://claude.com/pricing', disclosure: DISCLOSURE,
  };
}
