import { test } from 'node:test';
import assert from 'node:assert/strict';
import { appendFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { readLines } from '../src/jsonl.ts';
import { tmp, put } from './helpers.ts';

test('readLines stops before a partial trailing line and resumes from it', () => {
  const p = put(join(tmp(), 'a.jsonl'), '{"a":1}\n{"a":2}\n{"a":');
  const got: string[] = [];
  const off = readLines(p, 0, (l) => got.push(l)).offset;
  assert.deepEqual(got, ['{"a":1}', '{"a":2}']);
  assert.equal(off, 16);
  appendFileSync(p, '3}\n');
  const more: string[] = [];
  const off2 = readLines(p, off, (l) => more.push(l)).offset;
  assert.deepEqual(more, ['{"a":3}']);
  assert.equal(off2, statSync(p).size);
});

test('readLines handles lines longer than the chunk size and multibyte text across chunks', () => {
  const p = put(join(tmp(), 'b.jsonl'), '{"t":"héllo wörld"}\n\n{"t":"x"}\n');
  const got: string[] = [];
  const off = readLines(p, 0, (l) => got.push(l), 5).offset;
  assert.deepEqual(got, ['{"t":"héllo wörld"}', '{"t":"x"}']);
  assert.equal(off, statSync(p).size);
});

test('readLines from the end of the file reads nothing', () => {
  const p = put(join(tmp(), 'c.jsonl'), '{"a":1}\n');
  const got: string[] = [];
  assert.equal(readLines(p, 8, (l) => got.push(l)).offset, 8);
  assert.deepEqual(got, []);
});

test('readLines drops lines over the size cap and keeps the lines around them', () => {
  const giant = `{"pad":"${'x'.repeat(60)}"}`; // 70 bytes, over the 20-byte cap below
  const p = put(join(tmp(), 'd.jsonl'), `{"a":1}\n${giant}\n{"a":2}\n`);
  const got: string[] = [];
  const r = readLines(p, 0, (l) => got.push(l), 8, 20); // giant spans chunks
  assert.deepEqual(got, ['{"a":1}', '{"a":2}']);
  assert.equal(r.dropped, 1);
  assert.equal(r.offset, statSync(p).size);
  const whole = put(join(tmp(), 'd2.jsonl'), `{"a":1}\n${giant}\n{"a":2}\n`);
  const got2: string[] = [];
  const r2 = readLines(whole, 0, (l) => got2.push(l), 256, 20); // giant whole in one chunk
  assert.deepEqual(got2, ['{"a":1}', '{"a":2}']);
  assert.equal(r2.dropped, 1);
  assert.equal(r2.offset, statSync(whole).size);
});

test('readLines leaves an unterminated oversized line unread and drops it once complete', () => {
  const p = put(join(tmp(), 'e.jsonl'), '{"a":1}\n{"huge":"' + 'x'.repeat(30));
  const got: string[] = [];
  const r = readLines(p, 0, (l) => got.push(l), 8, 12);
  assert.deepEqual(got, ['{"a":1}']);
  assert.equal(r.dropped, 0);
  assert.equal(r.offset, 8, 'the partial oversized line is re-read next time, not half-consumed');
  appendFileSync(p, '"}\n');
  const r2 = readLines(p, r.offset, () => {}, 8, 12);
  assert.equal(r2.dropped, 1);
  assert.equal(r2.offset, statSync(p).size);
});
