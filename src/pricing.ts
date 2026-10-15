import { readFileSync } from 'node:fs';

export interface Usage { input: number; output: number; cacheRead: number; cacheWrite: number; cacheWrite1h: number }
export type Price = Usage; // USD per token, per field

const file = JSON.parse(readFileSync(new URL('./prices.json', import.meta.url), 'utf8')) as { asOf: string; models: Record<string, Price> };
export const PRICES_AS_OF = file.asOf;

/** Exact model id, then without a provider prefix ("openai/gpt-x"), then without a date suffix ("-20251001"). */
export function priceFor(model: string | null | undefined, models = file.models): Price | undefined {
  if (!model) return;
  const bare = model.replace(/^[\w.-]+\//, '');
  return models[model] ?? models[bare] ?? models[bare.replace(/-\d{8}$/, '')];
}

/** Estimated API-equivalent cost in USD, or null when the model has no known price. */
export function costOf(model: string | null | undefined, u: Usage, models = file.models): number | null {
  const p = priceFor(model, models);
  if (!p) return null;
  return u.input * p.input + u.output * p.output + u.cacheRead * p.cacheRead
    + (u.cacheWrite - u.cacheWrite1h) * p.cacheWrite + u.cacheWrite1h * p.cacheWrite1h;
}
