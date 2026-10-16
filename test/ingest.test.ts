import { test } from 'node:test';
import assert from 'node:assert/strict';
import { appendFileSync, mkdirSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { getCursor, openDb, type DB } from '../src/db.ts';
import { ingest } from '../src/ingest.ts';
import { claude } from '../src/adapters/claude.ts';
import type { Adapter } from '../src/types.ts';
import { tmp, put, jsonl, cAssistant } from './helpers.ts';

const totals = (db: DB) => ({ ...db.prepare(`SELECT count(*) AS n, sum(output) AS out FROM events WHERE kind = 'assistant'`).get() });

test('ingest is incremental, merges streamed duplicates, and survives a file shrinking', async () => {
  const home = tmp();
  const repo = join(home, 'code/app');
  mkdirSync(join(repo, '.git'), { recursive: true });
  put(join(repo, '.git/HEAD'), 'ref: refs/heads/main\n');
  const file = put(join(home, '.claude/projects/-code-app/s1.jsonl'), jsonl(
    cAssistant({ msg: 'm1', out: 10, cwd: repo }),
    cAssistant({ msg: 'm1', out: 40, cwd: repo }),
    cAssistant({ msg: 'm2', req: 'r2', out: 5, cwd: repo }),
  ));
  const db = openDb(':memory:');
  const offsets: number[] = []; // the offset each read() started from
  const spy: Adapter = { ...claude, read: (path, cursor) => { offsets.push(cursor.offset); return claude.read(path, cursor); } };

  let s = await ingest(db, home, [spy]);
  assert.equal(s.read, 1);
  assert.deepEqual(offsets, [0]);
  assert.deepEqual(totals(db), { n: 2, out: 45 });
  const firstSize = statSync(file).size;
  assert.equal(getCursor(db, file)!.offset, firstSize);

  s = await ingest(db, home, [spy]);
  assert.equal(s.read, 0, 'unchanged file is skipped');
  assert.deepEqual(offsets, [0], 'unchanged file is not read at all');

  appendFileSync(file, jsonl(cAssistant({ msg: 'm3', req: 'r3', out: 1, cwd: repo })));
  await ingest(db, home, [spy]);
  assert.deepEqual(offsets, [0, firstSize], 'an appended file resumes from the previous size, not 0');
  assert.deepEqual(totals(db), { n: 3, out: 46 });
  const grownSize = statSync(file).size;
  assert.equal(getCursor(db, file)!.offset, grownSize);

  // shrank: re-read from 0, and a brand-new event in the rewritten file must still be picked up
  writeFileSync(file, jsonl(cAssistant({ msg: 'm1', out: 40, cwd: repo }), cAssistant({ msg: 'm4', req: 'r4', out: 2, cwd: repo })));
  const shrunkSize = statSync(file).size;
  assert.ok(shrunkSize < grownSize);
  await ingest(db, home, [spy]);
  assert.deepEqual(offsets, [0, firstSize, 0], 'a shrunk file is re-read from 0');
  assert.deepEqual(totals(db), { n: 4, out: 48 }, 'no double counting, and the new event is ingested');
  assert.equal(getCursor(db, file)!.offset, shrunkSize);

  const p = db.prepare('SELECT p.root, p.name FROM sessions s JOIN projects p ON p.id = s.project_id').get() as { root: string; name: string };
  assert.deepEqual({ ...p }, { root: repo, name: 'app' });
});

test('a file that vanishes between discover and read does not stop the others', async () => {
  const home = tmp();
  const good = put(join(home, 'good.jsonl'), jsonl(cAssistant({ msg: 'ok' })));
  const broken = { ...claude, root: () => home, discover: () => [join(home, 'missing.jsonl'), good] };
  const s = await ingest(openDb(':memory:'), home, [broken]);
  assert.equal(s.read, 1);
});

test('a non-string cwd in a log does not stop other files', async () => {
  const home = tmp();
  put(join(home, '.claude/projects/-a/bad.jsonl'), jsonl(cAssistant({ msg: 'bad', session: 'sbad', cwd: 5 as never })));
  put(join(home, '.claude/projects/-b/good.jsonl'), jsonl(cAssistant({ msg: 'good', session: 'sgood' })));
  const db = openDb(':memory:');
  const s = await ingest(db, home, [claude]);
  assert.equal(s.read, 2);
  assert.equal(s.errors, 0);
  assert.deepEqual(totals(db).n, 2);
  assert.equal((db.prepare(`SELECT project_id FROM sessions WHERE id = 'sbad'`).get() as { project_id: number | null }).project_id, null);
});

test('a file whose write fails is rolled back, counted, and does not stop the others', async (t) => {
  const log = t.mock.method(console, 'error', () => {});
  const home = tmp();
  const bad = put(join(home, 'bad.jsonl'), jsonl(cAssistant({ msg: 'bad', session: 'sbad' })));
  const good = put(join(home, 'good.jsonl'), jsonl(cAssistant({ msg: 'good', session: 'sgood' })));
  const poisoned: Adapter = { // an unbindable value makes the SQLite write throw inside the transaction
    ...claude, root: () => home, discover: () => [bad, good],
    read: (path, cursor) => {
      const r = claude.read(path, cursor);
      return path === bad ? { ...r, events: r.events.map((e) => ({ ...e, input: {} as never })) } : r;
    },
  };
  const db = openDb(':memory:');
  const s = await ingest(db, home, [poisoned]);
  assert.equal(s.read, 1);
  assert.equal(s.errors, 1);
  assert.deepEqual(totals(db).n, 1);
  assert.equal(getCursor(db, bad), undefined, 'the failed file left no cursor behind');
  assert.ok(getCursor(db, good));
  assert.equal(log.mock.callCount(), 1);
  assert.match(String(log.mock.calls[0].arguments[0]), /agentlens: could not ingest .*bad\.jsonl: /);
});

test('sqlite database files shrinking resets offset to 0 but preserves cursor state', async () => {
  const home = tmp();
  const dbFile = join(home, 'test.db');
  writeFileSync(dbFile, 'x'.repeat(100));

  const db = openDb(':memory:');
  const seenCursors: any[] = [];
  const dbAdapter: Adapter = {
    agent: 'opencode',
    root: () => home,
    discover: () => [dbFile],
    read: (path, cursor) => {
      seenCursors.push({ ...cursor });
      return {
        events: [],
        sessions: [],
        quotas: [],
        cursor: { offset: 100, state: { lastMessageTs: '9999' } },
        errors: 0,
        skipped: 0,
      };
    },
  };

  // First ingest: offset 0
  await ingest(db, home, [dbAdapter]);
  assert.equal(seenCursors.length, 1);
  assert.deepEqual(seenCursors[0], { offset: 0, state: {} });

  // Simulate WAL checkpoint: db file size shrinks from 100 to 50
  writeFileSync(dbFile, 'x'.repeat(50));
  await ingest(db, home, [dbAdapter]);
  assert.equal(seenCursors.length, 2);
  assert.equal(seenCursors[1].offset, 0);
  assert.deepEqual(seenCursors[1].state, { lastMessageTs: '9999' });
});

