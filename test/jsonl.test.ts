import { test } from 'node:test';
import assert from 'node:assert/strict';
import { appendFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { readLines } from '../src/jsonl.ts';
import { tmp, put } from './helpers.ts';

test('readLines stops before a partial trailing line and resumes from it', () => {
  const p = put(join(tmp(), 'a.jsonl'), '{"a":1}\n{"a":2}\n{"a":');
  const got: string[] = [];
  const off = readLines(p, 0, (l) => got.push(l));
  assert.deepEqual(got, ['{"a":1}', '{"a":2}']);
  assert.equal(off, 16);
  appendFileSync(p, '3}\n');
  const more: string[] = [];
  const off2 = readLines(p, off, (l) => more.push(l));
  assert.deepEqual(more, ['{"a":3}']);
  assert.equal(off2, statSync(p).size);
});

test('readLines handles lines longer than the chunk size and multibyte text across chunks', () => {
  const p = put(join(tmp(), 'b.jsonl'), '{"t":"héllo wörld"}\n\n{"t":"x"}\n');
  const got: string[] = [];
  const off = readLines(p, 0, (l) => got.push(l), 5);
  assert.deepEqual(got, ['{"t":"héllo wörld"}', '{"t":"x"}']);
  assert.equal(off, statSync(p).size);
});

test('readLines from the end of the file reads nothing', () => {
  const p = put(join(tmp(), 'c.jsonl'), '{"a":1}\n');
  const got: string[] = [];
  assert.equal(readLines(p, 8, (l) => got.push(l)), 8);
  assert.deepEqual(got, []);
});
