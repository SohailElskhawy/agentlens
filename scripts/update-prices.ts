// Dev-time only: refreshes src/prices.json from LiteLLM's public price table (the source ccusage uses).
// agentlens never fetches prices at runtime.
import { writeFileSync } from 'node:fs';

const SOURCE = 'https://raw.githubusercontent.com/BerriAI/litellm/main/model_prices_and_context_window.json';
const KEEP = /^(claude-|gpt-|o[134]|codex|gemini-|deepseek|glm-|kimi-|qwen)/;

const res = await fetch(SOURCE);
if (!res.ok) throw new Error(`fetch ${SOURCE}: ${res.status}`);
const raw = (await res.json()) as Record<string, any>;
const models: Record<string, unknown> = {};
for (const [id, m] of Object.entries(raw)) {
  if (!KEEP.test(id) || !['chat', 'responses'].includes(m.mode) || m.input_cost_per_token == null) continue;
  const cacheWrite = m.cache_creation_input_token_cost ?? m.input_cost_per_token;
  models[id] = {
    input: m.input_cost_per_token,
    output: m.output_cost_per_token ?? 0,
    cacheRead: m.cache_read_input_token_cost ?? m.input_cost_per_token,
    cacheWrite,
    cacheWrite1h: m.cache_creation_input_token_cost_above_1hr ?? cacheWrite,
  };
}
const out = { asOf: new Date().toISOString().slice(0, 10), source: SOURCE, models };
writeFileSync(new URL('../src/prices.json', import.meta.url), JSON.stringify(out, null, 1) + '\n');
console.log(`wrote ${Object.keys(models).length} models`);
