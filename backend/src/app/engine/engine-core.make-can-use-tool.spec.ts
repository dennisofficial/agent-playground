import { describe, expect, it } from 'vitest';
import { makeCanUseTool } from './engine-core';

/**
 * `makeCanUseTool`'s read-only-turn and root-confinement checks now delegate to the shared
 * `@workspace/agent-engine` `evaluateWriteGuard` (thread 3's write-guard centralization) instead of
 * duplicating the predicate inline. This spec locks in that the deny messages/behavior stayed
 * byte-identical to the pre-refactor inline checks — the whole point of the refactor was zero behavior
 * change for Claude.
 */
describe('makeCanUseTool — write-guard delegation to evaluateWriteGuard', () => {
  it('denies Write/Edit with the exact legacy read-only message when readOnly=true', async () => {
    const canUseTool = makeCanUseTool(true, '/tmp/wt', () => {});
    const result = await canUseTool(
      'Write',
      { file_path: '/tmp/wt/foo.ts' } as never,
      {} as never,
    );
    expect(result).toEqual({
      behavior: 'deny',
      message: 'This is a read-only turn — no file writes.',
    });
  });

  it('denies a write outside the allowed roots with the exact legacy message', async () => {
    const canUseTool = makeCanUseTool(false, '/tmp/wt', () => {});
    const result = await canUseTool(
      'Write',
      { file_path: '/etc/passwd' } as never,
      {} as never,
    );
    expect(result).toEqual({
      behavior: 'deny',
      message:
        'Write outside the allowed roots (/tmp/wt) is not allowed: /etc/passwd',
    });
  });

  it('allows a write inside the allowed roots when not read-only', async () => {
    const canUseTool = makeCanUseTool(false, '/tmp/wt', () => {});
    const result = await canUseTool(
      'Write',
      { file_path: '/tmp/wt/foo.ts' } as never,
      {} as never,
    );
    expect(result).toEqual({
      behavior: 'allow',
      updatedInput: { file_path: '/tmp/wt/foo.ts' },
    });
  });

  it('leaves non-Write/Edit tools untouched by the write-guard checks', async () => {
    const canUseTool = makeCanUseTool(true, '/tmp/wt', () => {});
    const result = await canUseTool(
      'Bash',
      { command: 'ls' } as never,
      {} as never,
    );
    expect(result).toEqual({
      behavior: 'allow',
      updatedInput: { command: 'ls' },
    });
  });

  it('still consults the optional writeGuard hook AFTER the built-in checks pass', async () => {
    const canUseTool = makeCanUseTool(
      false,
      '/tmp/wt',
      () => {},
      undefined,
      () => ({
        allow: false,
        reason: 'denied by extra hook',
      }),
    );
    const result = await canUseTool(
      'Write',
      { file_path: '/tmp/wt/foo.ts' } as never,
      {} as never,
    );
    expect(result).toEqual({
      behavior: 'deny',
      message: 'denied by extra hook',
    });
  });
});
