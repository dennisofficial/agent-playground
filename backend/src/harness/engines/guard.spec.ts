import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The bash guard + the relaxed-sandbox posture (Phase 10).
 *
 * Two things are pinned here:
 *  1) HOST behavior is UNCHANGED — `bashDenyReason` still blocks the destructive forms and
 *     `bashWriteReason` still blocks mutations, exactly as before this phase. (These are pure, env-
 *     independent functions.)
 *  2) `relaxedSandboxGuard()` reflects `SANDBOX_GUARD_RELAXED` — false by default (the host), true only
 *     when the daemon/image sets the flag. Because the flag is parsed ONCE at module load, each case
 *     re-imports the module under a fresh `process.env` via `vi.resetModules()`.
 */

describe('guard — bashDenyReason (destructive denylist, ALWAYS active)', () => {
  it('blocks the hard-destructive forms', async () => {
    const { bashDenyReason } = await import('./guard.js');
    expect(bashDenyReason('rm -rf /')).toBeTruthy();
    expect(bashDenyReason('sudo apt-get install x')).toBeTruthy();
    expect(bashDenyReason(':(){ :|:& };:')).toBeTruthy();
    expect(bashDenyReason('mkfs.ext4 /dev/sda')).toBeTruthy();
    expect(bashDenyReason('dd if=/dev/zero of=/dev/sda')).toBeTruthy();
    expect(bashDenyReason('echo x > /etc/passwd')).toBeTruthy();
  });

  it('allows ordinary dev commands', async () => {
    const { bashDenyReason } = await import('./guard.js');
    expect(bashDenyReason('pnpm install')).toBeNull();
    expect(bashDenyReason('pnpm dev &')).toBeNull();
    expect(bashDenyReason('curl localhost:3000')).toBeNull();
    expect(bashDenyReason('docker compose up -d')).toBeNull();
    expect(bashDenyReason('rm -rf node_modules')).toBeNull(); // not the root
  });
});

describe('guard — bashWriteReason (read-only mutation blocker, UNCHANGED)', () => {
  it('flags mutations and passes reads', async () => {
    const { bashWriteReason } = await import('./guard.js');
    expect(bashWriteReason('rm foo')).toBeTruthy();
    expect(bashWriteReason('pnpm install')).toBeTruthy();
    expect(bashWriteReason('git commit -m x')).toBeTruthy();
    expect(bashWriteReason('echo x > file')).toBeTruthy();
    expect(bashWriteReason('ls -la')).toBeNull();
    expect(bashWriteReason('git status')).toBeNull();
    expect(bashWriteReason('cat file')).toBeNull();
  });
});

describe('guard — relaxedSandboxGuard (env-gated, host=false)', () => {
  const prev = process.env.SANDBOX_GUARD_RELAXED;
  beforeEach(() => vi.resetModules());
  afterEach(() => {
    if (prev === undefined) delete process.env.SANDBOX_GUARD_RELAXED;
    else process.env.SANDBOX_GUARD_RELAXED = prev;
    vi.resetModules();
  });

  it('is FALSE when the flag is unset (the host — behavior unchanged)', async () => {
    delete process.env.SANDBOX_GUARD_RELAXED;
    const { relaxedSandboxGuard } = await import('./guard.js');
    expect(relaxedSandboxGuard()).toBe(false);
  });

  it('is FALSE for a non-"true" value (e.g. accidental "false"/"1")', async () => {
    process.env.SANDBOX_GUARD_RELAXED = 'false';
    let mod = await import('./guard.js');
    expect(mod.relaxedSandboxGuard()).toBe(false);
    vi.resetModules();
    process.env.SANDBOX_GUARD_RELAXED = '1';
    mod = await import('./guard.js');
    expect(mod.relaxedSandboxGuard()).toBe(false);
  });

  it('is TRUE only when the flag is exactly "true" (case/space tolerant)', async () => {
    process.env.SANDBOX_GUARD_RELAXED = '  TRUE  ';
    const { relaxedSandboxGuard } = await import('./guard.js');
    expect(relaxedSandboxGuard()).toBe(true);
  });
});
