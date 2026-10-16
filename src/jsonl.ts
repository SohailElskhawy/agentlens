import { closeSync, fstatSync, openSync, readSync } from 'node:fs';

const MAX_LINE = 512 * 1024;

let shared: Buffer | undefined; // reused across calls (they are sequential): per-call buffers pile up in RSS before GC
function accBuf(need: number): Buffer {
  if (shared === undefined || shared.length < need) shared = Buffer.alloc(need);
  return shared.length === need ? shared : shared.subarray(0, need);
}

/**
 * Calls onLine for each complete, non-empty line after `offset` and returns the offset just past the last
 * complete line. A trailing line without '\n' is left unread: the agent may still be writing it.
 * Reads into one persistent buffer, sliding the pending line to its front, so a full-history backfill
 * allocates nothing per line but the line itself.
 * shortcut: lines over 512KB are dropped un-parsed — one 62MB paste costs >1GB of RSS to JSON.parse and the
 * systemd unit caps memory at 200M; no token-bearing line measured on real logs exceeds 512KB, so only
 * pastes and tool outputs are lost — raise the cap if agents ever emit giant usage lines.
 */
export function readLines(
  path: string, offset: number, onLine: (line: string) => void,
  chunkSize = 4 * 1024 * 1024, maxLine = MAX_LINE,
): { offset: number; dropped: number } {
  const fd = openSync(path, 'r');
  try {
    const size = fstatSync(fd).size;
    const acc = accBuf(chunkSize + maxLine); // carry (≤ maxLine) + one chunk
    let pos = offset;
    let carryLen = 0; // bytes of the pending line held at acc[0..carryLen)
    let dropped = 0;
    let dropping = false; // inside a line already known to exceed maxLine; stop buffering it
    let lineStart = offset; // absolute start of the current unterminated line
    while (pos < size) {
      const readAt = pos;
      const n = readSync(fd, acc, carryLen, chunkSize, pos); // read straight in past the carry
      if (n === 0) break;
      pos += n;
      const end = carryLen + n;
      let start = 0;
      let nl: number;
      while ((nl = acc.subarray(0, end).indexOf(10, start)) !== -1) {
        if (dropping) { dropped++; dropping = false; }
        else if (nl - start > maxLine) dropped++;
        else {
          const line = acc.toString('utf8', start, nl);
          if (line.trim()) onLine(line);
        }
        start = nl + 1;
      }
      if (start > 0) lineStart = readAt - carryLen + start;
      carryLen = end - start;
      if (carryLen > 0) acc.copyWithin(0, start, end);
      if (carryLen > maxLine) { dropping = true; carryLen = 0; } // the carry never holds an oversized line
    }
    // An oversized line left unterminated is re-read from its start next run, so its tail is never half-consumed.
    return { offset: dropping ? lineStart : pos - carryLen, dropped };
  } finally {
    closeSync(fd);
  }
}
