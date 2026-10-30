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

// Fixture: Claude patterns current, Cursor pending. Both surfaces must use the whole
// ignoreFiles result array and show the pending Cursor patterns instead of claiming
// both files are up to date.
test('fixture claude-current cursor-pending shows per-file pending status, not a shared up-to-date claim', async () => {
  const view = await import(new URL('../web/optimize-view.js', import.meta.url).href);
  const ig = (fileName: string, addedPatterns: string[]) => ({ fileName, addedPatterns });
  const fixture = [ig('.claudeignore', []), ig('.cursorignore', ['build/'])];

  const card = view.optimizeIgnoreFilesCardHtml(fixture);
  assert.ok(card.includes('.cursorignore'), 'inline card must name the pending file');
  assert.ok(card.includes('build/'), 'inline card must show pending Cursor patterns');
  assert.doesNotMatch(card, /up to date/, 'cursor pending must not claim files up to date');

  const drawer = view.optimizeDrawerIgnoreFilesHtml(fixture);
  assert.ok(drawer.includes('.cursorignore'), 'drawer must name the pending file');
  assert.ok(drawer.includes('build/'), 'drawer must show pending Cursor patterns');
  assert.doesNotMatch(drawer, /already up to date/, 'cursor pending must not claim files already up to date');

  assert.equal(view.pendingIgFiles(fixture).length, 1, 'pending detection uses the whole result array');

  const bothCurrent = view.optimizeIgnoreFilesCardHtml([ig('.claudeignore', []), ig('.cursorignore', [])]);
  assert.match(bothCurrent, /up to date/, 'when both files are current the up-to-date message is fine');

  // Escaping of pattern text is preserved in the generated markup.
  const sneaky = view.optimizeIgnoreFilesCardHtml([ig('.claudeignore', []), ig('.cursorignore', ['<img src=x>'])]);
  assert.ok(sneaky.includes('&lt;img') && !sneaky.includes('<img'), 'ignore patterns must stay escaped');
});

test('inline instruction trim reductions carry an estimate label', async () => {
  const view = await import(new URL('../web/optimize-view.js', import.meta.url).href);
  const line = view.optimizeTrimLine([{ fileName: 'CLAUDE.md', tokensSaved: 1234 }]);
  assert.match(line, /CLAUDE\.md: -1\.2k tok\/turn est\./, 'inline per-file trims must be labeled as estimates');
});

test('optimize UI exposes only escaped server-provided CLI commands and visible preview errors', async () => {
  const { readFileSync } = await import('node:fs');
  const app = readFileSync('web/app.js', 'utf8');
  assert.doesNotMatch(app, /runApplyOptimize|btn-(?:drawer-)?apply-optimize|fetch\(['"]\/api\/optimize/);
  assert.match(app, /optimize preview (?:failed|unavailable)/i);
  assert.match(app, /esc\(.*cliCommand\)/);
  assert.match(app, /cliShell/);
  assert.match(app, /btn-copy-optimize-cli/);
});
