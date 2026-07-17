import { closeSync, openSync, readFileSync, readSync, statSync } from 'node:fs';
import { join } from 'node:path';

/** The last-N-lines tail of a service log, capped in bytes (shared by the REST snapshot and the SSE endpoint). */
export interface ServiceLogTail {
  content: string;
  truncated: boolean;
  /** Byte size of the file this tail was read from — the SSE endpoint's starting `offset`. */
  size: number;
}

/** Read the last `n` lines of `<dir>/<id>.log`, capped at `maxBytes`. Empty result if the file doesn't exist. */
export function readServiceLogTail(
  dir: string | null,
  id: string,
  n: number,
  maxBytes: number,
): ServiceLogTail {
  const path = join(dir ?? '', `${id}.log`);
  let st: ReturnType<typeof statSync>;
  try {
    st = statSync(path);
  } catch {
    return { content: '', truncated: false, size: 0 };
  }
  const truncated = st.size > maxBytes;
  const buf = readFileSync(path);
  const tail = truncated ? buf.subarray(buf.length - maxBytes) : buf;
  const content = tail.toString('utf8').split('\n').slice(-n).join('\n');
  return { content, truncated, size: st.size };
}

/** The decision an SSE tail poll tick makes, given the last known `offset` and the file's current `size`. */
export type TailPollResult =
  | { kind: 'unchanged' }
  | { kind: 'append'; chunk: string; nextOffset: number }
  | { kind: 'reset'; nextOffset: number };

/**
 * Pure decision logic for one poll tick: same size → nothing to do; grew → read only the new bytes at `fd`
 * (an fd already open on the log file); shrank → the file was truncated by an `atlas-svc run` restart, so
 * the caller must re-snapshot from scratch (a fresh `readServiceLogTail`) rather than trust `offset`.
 */
export function nextTailFrame(offset: number, size: number, fd: number): TailPollResult {
  if (size === offset) return { kind: 'unchanged' };
  if (size < offset) return { kind: 'reset', nextOffset: size };
  const len = size - offset;
  const buf = Buffer.alloc(len);
  readSync(fd, buf, 0, len, offset);
  return { kind: 'append', chunk: buf.toString('utf8'), nextOffset: size };
}

/** Open the log file for incremental reads; the caller closes it (via `closeTailFd`) on SSE teardown. */
export function openTailFd(path: string): number {
  return openSync(path, 'r');
}

export function closeTailFd(fd: number): void {
  try {
    closeSync(fd);
  } catch {
    /* already closed / fd gone with the file — fine on teardown */
  }
}
