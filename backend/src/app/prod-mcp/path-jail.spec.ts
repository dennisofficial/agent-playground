import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { resolveJailed } from './path-jail';

describe('resolveJailed', () => {
  let root: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'mcp-reader-jail-'));
    mkdirSync(join(root, 'sub'), { recursive: true });
    writeFileSync(join(root, 'sub', 'file.txt'), 'hi');
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it('accepts a normal subpath and resolves it under root', () => {
    const resolved = resolveJailed(root, 'sub/file.txt');
    expect(resolved.startsWith(root)).toBe(true);
    expect(resolved.endsWith(join('sub', 'file.txt'))).toBe(true);
  });

  it('accepts root itself', () => {
    expect(() => resolveJailed(root, '.')).not.toThrow();
  });

  it('rejects a .. traversal', () => {
    expect(() => resolveJailed(root, '../etc/passwd')).toThrow(
      'path escapes jail',
    );
    expect(() => resolveJailed(root, 'sub/../../etc/passwd')).toThrow(
      'path escapes jail',
    );
  });

  it('rejects an absolute path outside root', () => {
    expect(() => resolveJailed(root, '/etc/passwd')).toThrow(
      'path escapes jail',
    );
  });
});
