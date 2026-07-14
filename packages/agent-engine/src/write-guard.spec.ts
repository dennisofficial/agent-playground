import { describe, expect, it } from 'vitest';
import { evaluateWriteGuard, type WriteGuardCtx } from './write-guard.js';

function ctx(over: Partial<WriteGuardCtx> = {}): WriteGuardCtx {
  return { readOnly: false, roots: [], ...over };
}

describe('evaluateWriteGuard', () => {
  it('allows a non-mutating tool name regardless of readOnly', () => {
    expect(evaluateWriteGuard('Bash', { command: 'ls' }, ctx({ readOnly: true }))).toEqual({ allow: true });
    expect(evaluateWriteGuard('commandExecution', {}, ctx({ readOnly: true }))).toEqual({ allow: true });
  });

  it('denies Write/Edit/fileChange when readOnly with the exact message', () => {
    const expected = { allow: false, reason: 'This is a read-only turn — no file writes.' };
    expect(evaluateWriteGuard('Write', { file_path: '/root/a.txt' }, ctx({ readOnly: true }))).toEqual(expected);
    expect(evaluateWriteGuard('Edit', { file_path: '/root/a.txt' }, ctx({ readOnly: true }))).toEqual(expected);
    expect(evaluateWriteGuard('fileChange', { path: 'a.txt' }, ctx({ readOnly: true }))).toEqual(expected);
  });

  it('allows a write inside the allowed roots', () => {
    const verdict = evaluateWriteGuard(
      'Write',
      { file_path: '/root/sub/a.txt' },
      ctx({ roots: ['/root'] }),
    );
    expect(verdict).toEqual({ allow: true });
  });

  it('denies a write outside the allowed roots (Claude file_path shape)', () => {
    const verdict = evaluateWriteGuard('Write', { file_path: '/other/a.txt' }, ctx({ roots: ['/root'] }));
    expect(verdict).toEqual({
      allow: false,
      reason: 'Write outside the allowed roots (/root) is not allowed: /other/a.txt',
    });
  });

  it('denies a write outside the allowed roots (Codex path shape)', () => {
    const verdict = evaluateWriteGuard('fileChange', { path: '/other/a.txt' }, ctx({ roots: ['/root'] }));
    expect(verdict).toEqual({
      allow: false,
      reason: 'Write outside the allowed roots (/root) is not allowed: /other/a.txt',
    });
  });

  it('denies a write outside the allowed roots (Codex changes[] shape)', () => {
    const verdict = evaluateWriteGuard(
      'fileChange',
      { changes: [{ path: '/other/a.txt', kind: 'update' }] },
      ctx({ roots: ['/root'] }),
    );
    expect(verdict).toEqual({
      allow: false,
      reason: 'Write outside the allowed roots (/root) is not allowed: /other/a.txt',
    });
  });

  it('allows when roots is empty (no confinement configured)', () => {
    const verdict = evaluateWriteGuard('Write', { file_path: '/anywhere/a.txt' }, ctx({ roots: [] }));
    expect(verdict).toEqual({ allow: true });
  });
});
