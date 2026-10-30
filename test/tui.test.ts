import { test } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';
import type { SummaryData } from '../src/summary.ts';
import { renderTui, startTui } from '../src/tui.ts';
import { tmp } from './helpers.ts';

const fixture: SummaryData = {
  updatedAt: 1760000000000,
  totals: { tokensToday: 12345, costToday: 0.5, burnRateTokensPerHour: 6789, activeSessions: 2 },
  projects: {
    '/tmp/proj': {
      projectId: 1,
      root: '/tmp/proj',
      name: 'proj',
      tokensToday: 500,
      contextWarning: '[COMPACT RECOMMENDED]',
    },
  },
  quotas: { claude: { '5h': 42, '7d': 15 }, codex: { '5h': 30 } },
};

function fakeStdout(isTTY: boolean) {
  const writes: string[] = [];
  return {
    writes,
    isTTY,
    write(s: string) { writes.push(s); },
  };
}

interface Scheduled { fn: () => void; ms: number }

function fakeTimers() {
  const scheduled: Scheduled[] = [];
  const cleared: unknown[] = [];
  return {
    scheduled,
    cleared,
    setInterval: (fn: () => void, ms: number) => { scheduled.push({ fn, ms }); return scheduled.length; },
    clearInterval: (handle: unknown) => { cleared.push(handle); },
  };
}

test('renderTui includes claude 5h and 7d quota numbers and only present agent keys', () => {
  const out = renderTui(fixture);
  assert.ok(out.includes('5h 42%'), `missing 5h quota: ${out}`);
  assert.ok(out.includes('7d 15%'), `missing 7d quota: ${out}`);
  assert.ok(out.includes('codex'), 'missing codex line');
  assert.ok(!out.includes('codex 7d'), 'codex 7d must not be rendered when absent');
});

test('renderTui includes current token totals', () => {
  const out = renderTui(fixture);
  assert.ok(out.includes('12.3k'), `missing tokensToday: ${out}`);
  assert.ok(out.includes('6.8k'), `missing burn rate: ${out}`);
});

test('renderTui propagates project contextWarning', () => {
  const out = renderTui(fixture);
  assert.ok(out.includes('[COMPACT RECOMMENDED]'));
});

test('renderTui(null) is a single marker line', () => {
  const out = renderTui(null);
  assert.ok(out.includes('no summary cache yet'));
});

test('missing or unparsable cache prints marker line and schedules nothing', () => {
  const missing = fakeStdout(false);
  const timersA = fakeTimers();
  const cleanupA = startTui({
    summaryPath: join(tmp(), 'does-not-exist', 'summary.json'),
    stdout: missing,
    setInterval: timersA.setInterval,
    clearInterval: timersA.clearInterval,
  });
  assert.equal(missing.writes.length, 1);
  assert.ok(missing.writes[0].includes('no summary cache yet'));
  assert.equal(timersA.scheduled.length, 0);

  const dir = tmp();
  const unparsable = fakeStdout(false);
  const timersB = fakeTimers();
  writeFileSync(join(dir, 'summary.json'), 'not-json{{{');
  startTui({
    summaryPath: join(dir, 'summary.json'),
    stdout: unparsable,
    setInterval: timersB.setInterval,
    clearInterval: timersB.clearInterval,
  });
  assert.equal(unparsable.writes.length, 1);
  assert.ok(unparsable.writes[0].includes('no summary cache yet'));
  assert.equal(timersB.scheduled.length, 0);
  cleanupA();
});

test('non-TTY prints exactly one frame and schedules no interval', () => {
  const dir = tmp();
  const path = join(dir, 'summary.json');
  writeFileSync(path, JSON.stringify(fixture));
  const out = fakeStdout(false);
  const timers = fakeTimers();
  startTui({
    summaryPath: path,
    stdout: out,
    setInterval: timers.setInterval,
    clearInterval: timers.clearInterval,
  });
  assert.equal(out.writes.length, 1);
  assert.ok(out.writes[0].includes('5h 42%'));
  assert.equal(timers.scheduled.length, 0);
});

test('TTY schedules an interval; tick re-renders; cleanup clears it and last frame ends with newline', () => {
  const dir = tmp();
  const path = join(dir, 'summary.json');
  writeFileSync(path, JSON.stringify(fixture));
  const out = fakeStdout(true);
  const timers = fakeTimers();
  const cleanup = startTui({
    summaryPath: path,
    stdout: out,
    setInterval: timers.setInterval,
    clearInterval: timers.clearInterval,
  });
  assert.equal(timers.scheduled.length, 1);
  const frameCount = out.writes.length;
  timers.scheduled[0].fn();
  assert.ok(out.writes.length > frameCount, 'tick must re-render');
  cleanup();
  assert.equal(timers.cleared.length, 1);
  assert.equal(timers.cleared[0], timers.scheduled.length, 'clearInterval must receive the scheduled handle');
  assert.ok(out.writes.at(-1)!.endsWith('\n'), 'last frame must end with newline');
});

test('TTY interval defaults to 60s', () => {
  const dir = tmp();
  const path = join(dir, 'summary.json');
  writeFileSync(path, JSON.stringify(fixture));
  const timers = fakeTimers();
  startTui({
    summaryPath: path,
    stdout: fakeStdout(true),
    setInterval: timers.setInterval,
    clearInterval: timers.clearInterval,
  });
  assert.equal(timers.scheduled[0].ms, 60_000);
});

test('renderTui is fast on a fixture', () => {
  const start = performance.now();
  for (let i = 0; i < 100; i++) renderTui(fixture);
  const elapsed = performance.now() - start;
  assert.ok(elapsed < 10, `100 renders took ${elapsed.toFixed(2)}ms`);
});
