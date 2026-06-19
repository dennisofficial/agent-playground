/**
 * `DaemonGitService.version()` — the daemon's self-reported build version, the signal the host's boot-time
 * daemon-version reconciliation compares against the just-built volume version (a mismatch ⇒ restart onto
 * the new daemon). No git, no Redis: `version()` only reads the `.build-version` stamp next to the mounted
 * entry (`dirname(DAEMON_ENTRY)/.build-version`), so we point `DAEMON_ENTRY` at a temp dir and assert it
 * reports the stamp, an empty string when the stamp is absent, and never throws.
 */
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Logger } from '@nestjs/common';
import { GithubApiService } from '@harness/projects/github-api.service';
import { DaemonGitService } from './daemon-git.service';
import type { GitCredentialProvider } from './git-credential.provider';

const fakeCredentials: GitCredentialProvider = {
  resolve: async () => ({
    token: '',
    authorName: 'Agent',
    authorEmail: 'agent@agents.noreply',
  }),
};

function makeService(): DaemonGitService {
  return new DaemonGitService(fakeCredentials, new GithubApiService());
}

describe('DaemonGitService.version() — self-reported daemon build version', () => {
  let mountDir: string;
  let entryDir: string;
  const prevEntry = process.env.DAEMON_ENTRY;

  beforeEach(async () => {
    vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    mountDir = await mkdtemp(join(tmpdir(), 'dg-version-'));
    // Mirror the in-sandbox layout: the entry + the stamp live in the SAME dir.
    entryDir = join(mountDir, 'backend', 'dist', 'daemon');
    await mkdir(entryDir, { recursive: true });
    await writeFile(join(entryDir, 'main.js'), '// built daemon\n');
    process.env.DAEMON_ENTRY = join(entryDir, 'main.js');
  });

  afterEach(async () => {
    if (prevEntry === undefined) delete process.env.DAEMON_ENTRY;
    else process.env.DAEMON_ENTRY = prevEntry;
    await rm(mountDir, { recursive: true, force: true });
  });

  it('reports the .build-version stamp next to the mounted entry', async () => {
    await writeFile(join(entryDir, '.build-version'), 'deadbeefcafe\n');
    const svc = makeService();
    expect(await svc.version()).toEqual({ buildVersion: 'deadbeefcafe' });
  });

  it('reports an empty string when the stamp is absent (a build predating the stamp) — never throws', async () => {
    const svc = makeService();
    // No .build-version written → the host treats '' as a definite mismatch and restarts the sandbox.
    await expect(svc.version()).resolves.toEqual({ buildVersion: '' });
  });

  it('falls back to the default mount path when DAEMON_ENTRY is unset (reads nothing → empty)', async () => {
    delete process.env.DAEMON_ENTRY;
    const svc = makeService();
    // The default path (/daemon/...) doesn't exist in the test env → empty, no throw.
    await expect(svc.version()).resolves.toEqual({ buildVersion: '' });
  });
});
