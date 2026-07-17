import { closeSync, openSync, readFileSync, readSync, statSync } from 'node:fs';
import { join } from 'node:path';

export interface ServiceLogTail {
  content: string;
  truncated: boolean;
  size: number;
}

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

export type TailPollResult =
  | { kind: 'unchanged' }
  | { kind: 'append'; chunk: string; nextOffset: number }
  | { kind: 'reset'; nextOffset: number };

export function nextTailFrame(offset: number, size: number, fd: number): TailPollResult {
  if (size === offset) return { kind: 'unchanged' };
  if (size < offset) return { kind: 'reset', nextOffset: size };
  const len = size - offset;
  const buf = Buffer.alloc(len);
  readSync(fd, buf, 0, len, offset);
  return { kind: 'append', chunk: buf.toString('utf8'), nextOffset: size };
}

export function openTailFd(path: string): number {
  return openSync(path, 'r');
}

export function closeTailFd(fd: number): void {
  try {
    closeSync(fd);
  } catch {}
}
