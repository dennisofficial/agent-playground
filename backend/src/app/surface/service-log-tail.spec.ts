import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { closeTailFd, nextTailFrame, openTailFd, readServiceLogTail } from './service-log-tail';

describe('readServiceLogTail', () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'atlas-svc-log-'));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('returns empty content when the log file does not exist yet', () => {
    expect(readServiceLogTail(dir, 'missing', 200, 1024)).toEqual({
      content: '',
      truncated: false,
      size: 0,
    });
  });

  it('returns the whole file when under the line/byte caps', () => {
    writeFileSync(join(dir, 'web.log'), 'line1\nline2\nline3');
    const tail = readServiceLogTail(dir, 'web', 200, 1024);
    expect(tail).toEqual({
      content: 'line1\nline2\nline3',
      truncated: false,
      size: 17,
    });
  });

  it('caps to the last n lines', () => {
    writeFileSync(join(dir, 'web.log'), 'a\nb\nc\nd\n');
    const tail = readServiceLogTail(dir, 'web', 2, 1024);
    expect(tail.content).toBe('d\n');
  });
});

describe('nextTailFrame', () => {
  let dir: string;
  let path: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'atlas-svc-tail-'));
    path = join(dir, 'web.log');
    writeFileSync(path, 'hello\n');
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('reports unchanged when size matches the tracked offset', () => {
    const fd = openTailFd(path);
    try {
      expect(nextTailFrame(6, 6, fd)).toEqual({ kind: 'unchanged' });
    } finally {
      closeTailFd(fd);
    }
  });

  it('reads only the newly-appended bytes when the file grew', () => {
    const fd = openTailFd(path);
    try {
      writeFileSync(path, 'world\n', { flag: 'a' });
      const result = nextTailFrame(6, 12, fd);
      expect(result).toEqual({
        kind: 'append',
        chunk: 'world\n',
        nextOffset: 12,
      });
    } finally {
      closeTailFd(fd);
    }
  });

  it('reports a reset when the file shrank below the tracked offset (atlas-svc run restart truncation)', () => {
    const fd = openTailFd(path);
    try {
      expect(nextTailFrame(6, 0, fd)).toEqual({ kind: 'reset', nextOffset: 0 });
    } finally {
      closeTailFd(fd);
    }
  });
});
