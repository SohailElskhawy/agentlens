import { test } from 'node:test';
import assert from 'node:assert/strict';
import { appendFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { openDb, type DB } from '../src/db.ts';
import { ingest } from '../src/ingest.ts';
import { claude } from '../src/adapters/claude.ts';
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

  let s = await ingest(db, home, [claude]);
  assert.equal(s.read, 1);
  assert.deepEqual(totals(db), { n: 2, out: 45 });

  s = await ingest(db, home, [claude]);
  assert.equal(s.read, 0, 'unchanged file is skipped');

  appendFileSync(file, jsonl(cAssistant({ msg: 'm3', req: 'r3', out: 1, cwd: repo })));
  await ingest(db, home, [claude]);
  assert.deepEqual(totals(db), { n: 3, out: 46 });

  writeFileSync(file, jsonl(cAssistant({ msg: 'm1', out: 40, cwd: repo }))); // shrank: re-read from 0
  await ingest(db, home, [claude]);
  assert.deepEqual(totals(db), { n: 3, out: 46 }, 'no double counting after a re-read');

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
