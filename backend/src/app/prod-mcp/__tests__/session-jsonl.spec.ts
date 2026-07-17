import {
  mkdtempSync,
  mkdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { findSandboxDir, listSessionFiles } from '../session-jsonl';

describe('listSessionFiles', () => {
  let root: string;
  let outside: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'mcp-reader-sessions-'));
    outside = mkdtempSync(join(tmpdir(), 'mcp-reader-outside-'));
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
    rmSync(outside, { recursive: true, force: true });
  });

  it('skips symlinked transcript paths', () => {
    const insideProject = join(
      root,
      'org',
      'repo',
      'job',
      'brain',
      'claude',
      'projects',
      '-workspace',
    );
    mkdirSync(insideProject, { recursive: true });
    writeFileSync(join(insideProject, 'inside.jsonl'), '{}\n');

    const outsideProject = join(outside, 'claude', 'projects', '-workspace');
    mkdirSync(outsideProject, { recursive: true });
    writeFileSync(join(outsideProject, 'outside.jsonl'), '{}\n');
    symlinkSync(outside, join(root, 'linked-outside'), 'dir');

    expect(listSessionFiles(root).map((f) => f.sessionId)).toEqual(['inside']);
  });

  it('does not select a symlinked sandbox dir and prefers the longest matching job suffix', () => {
    const agentHome = mkdtempSync(join(tmpdir(), 'mcp-reader-agent-home-'));
    try {
      const sandboxes = join(agentHome, 'sandboxes');
      mkdirSync(sandboxes, { recursive: true });
      mkdirSync(join(sandboxes, 'atlas-sbx-thread-abc'), {
        recursive: true,
      });
      mkdirSync(join(sandboxes, 'atlas-sbx-thread-abcdef'), {
        recursive: true,
      });
      symlinkSync(outside, join(sandboxes, 'atlas-sbx-thread-abcdefg'), 'dir');

      expect(findSandboxDir(agentHome, 'abcdefghi')).toBe(
        join(sandboxes, 'atlas-sbx-thread-abcdef'),
      );
    } finally {
      rmSync(agentHome, { recursive: true, force: true });
    }
  });
});
