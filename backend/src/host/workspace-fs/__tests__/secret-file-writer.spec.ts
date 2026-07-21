import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { SecretFileWriter } from '../secret-file-writer';

describe('writeSecretFiles', () => {
  let dir: string;
  let writer: SecretFileWriter;

  beforeEach(async () => {
    dir = await fs.mkdtemp(join(tmpdir(), 'atlas-secrets-'));
    writer = new SecretFileWriter();
  });

  afterEach(async () => {
    await fs.rm(dir, { recursive: true, force: true });
  });

  it('writes workspace-relative secret files (nested dirs created, 0600)', async () => {
    await writer.write(dir, [
      { path: '.env.local', label: null, value: 'TOKEN=abc' },
      { path: 'config/nested.json', label: null, value: '{}' },
    ]);

    expect(await fs.readFile(join(dir, '.env.local'), 'utf8')).toBe('TOKEN=abc');
    expect(await fs.readFile(join(dir, 'config/nested.json'), 'utf8')).toBe('{}');
    expect((await fs.stat(join(dir, '.env.local'))).mode & 0o777).toBe(0o600);
  });

  it('refuses a path that escapes the workspace via ..', async () => {
    await expect(
      writer.write(dir, [{ path: '../escape.env', label: null, value: 'x' }]),
    ).rejects.toThrow(/escapes the workspace/);
  });

  it('refuses an absolute path (never writes outside the workspace)', async () => {
    await expect(
      writer.write(dir, [{ path: '/etc/evil', label: null, value: 'x' }]),
    ).rejects.toThrow(/escapes the workspace/);
  });
});
