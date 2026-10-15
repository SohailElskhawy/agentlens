import { closeSync, fstatSync, openSync, readSync } from 'node:fs';

/**
 * Calls onLine for each complete, non-empty line after `offset` and returns the offset just past the last
 * complete line. A trailing line without '\n' is left unread: the agent may still be writing it.
 * Reads in chunks so a large log never has to fit in memory at once.
 */
export function readLines(path: string, offset: number, onLine: (line: string) => void, chunkSize = 4 * 1024 * 1024): number {
  const fd = openSync(path, 'r');
  try {
    const size = fstatSync(fd).size;
    const buf = Buffer.alloc(chunkSize);
    let pos = offset;
    let carry = Buffer.alloc(0);
    while (pos < size) {
      const n = readSync(fd, buf, 0, chunkSize, pos);
      if (n === 0) break;
      pos += n;
      const data = carry.length ? Buffer.concat([carry, buf.subarray(0, n)]) : buf.subarray(0, n);
      let start = 0;
      let nl: number;
      while ((nl = data.indexOf(10, start)) !== -1) {
        const line = data.toString('utf8', start, nl);
        if (line.trim()) onLine(line);
        start = nl + 1;
      }
      carry = Buffer.from(data.subarray(start)); // copy: `buf` is reused next iteration
    }
    return pos - carry.length;
  } finally {
    closeSync(fd);
  }
}
