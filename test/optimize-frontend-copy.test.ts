import test from 'node:test';
import assert from 'node:assert/strict';

// T46 bounded copy correction: web/app.js optimize surfaces (inline project panel,
// optimization drawer, success toast) must match the structured WorkspaceOptimizeResult
// capability contract from src/optimize.ts: estimated instruction reduction is labeled
// estimated (never measured/realized), oversized-file exposure is not claimed as savings,
// .claudeignore has no effect in Claude Code, and .cursorignore is provider-specific
// rather than an all-tool shield.

test('optimize surfaces avoid unsupported savings/shield claims in web/app.js', async () => {
  const { readFileSync } = await import('node:fs');
  const { spawnSync } = await import('node:child_process');
  const check = spawnSync(process.execPath, ['--check', 'web/app.js'], { encoding: 'utf8' });
  assert.equal(check.status, 0, check.stderr);
  const appJs = readFileSync('web/app.js', 'utf8');
  // No "shield" framing anywhere: .claudeignore does not shield in Claude Code.
  assert.ok(!/shield/i.test(appJs), 'optimize copy must not use shield framing');
  // Estimated, not measured: a success toast must not claim realized "saved" tokens.
  assert.ok(!appJs.includes('tok/turn saved'), 'toast must not claim measured tok/turn saved');
  // Ignore files renamed to what they are, with the provider caveat present.
  assert.ok(appJs.includes('Ignore Files'), 'optimize surfaces must label ignore files as Ignore Files');
  assert.ok(appJs.includes('no effect in Claude Code'), 'must state .claudeignore has no effect in Claude Code');
  assert.ok(appJs.includes('provider-specific'), 'must state .cursorignore is provider-specific');
  // Header estimate labels say reduction, not savings.
  assert.ok(appJs.includes('est. reduction'), 'panel headline must label the estimate as reduction');
  // Oversized-file exposure is labeled exposure, not savings.
  assert.ok(appJs.includes('context exposure'), 'oversized files must be labeled context exposure');
});
