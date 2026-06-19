import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ensureCodexSubscriptionHome } from './codex-subscription-home';
import { engineHomeDir } from './engine-home';

describe('ensureCodexSubscriptionHome', () => {
  let root: string;
  const AGENT = 'atlas';
  const TEAM = 'team-1';

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'codex-sub-home-'));
  });
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  const canonical = () => engineHomeDir(root, 'codex', AGENT);

  it('writes auth.json from the secret and a per-(team,agent) overlay separate from the canonical home', () => {
    const overlay = ensureCodexSubscriptionHome(root, TEAM, AGENT, 'AUTH-JSON-1');
    expect(overlay).not.toBe(canonical());
    expect(readFileSync(join(overlay, 'auth.json'), 'utf8')).toBe('AUTH-JSON-1');
  });

  it('symlinks config.toml / AGENTS.md from the canonical home so provisioner updates propagate', () => {
    writeFileSync(join(canonical(), 'config.toml'), 'V1');
    writeFileSync(join(canonical(), 'AGENTS.md'), 'skills-v1');
    const overlay = ensureCodexSubscriptionHome(root, TEAM, AGENT, 'sek');
    expect(readFileSync(join(overlay, 'config.toml'), 'utf8')).toBe('V1');

    // Update the canonical file — the overlay (a symlink) reflects it without re-seeding.
    writeFileSync(join(canonical(), 'config.toml'), 'V2');
    expect(readFileSync(join(overlay, 'config.toml'), 'utf8')).toBe('V2');
  });

  it('clears a stale mirrored symlink when the canonical file disappears', () => {
    writeFileSync(join(canonical(), 'config.toml'), 'V1');
    const overlay = ensureCodexSubscriptionHome(root, TEAM, AGENT, 'sek');
    expect(existsSync(join(overlay, 'config.toml'))).toBe(true);

    rmSync(join(canonical(), 'config.toml'));
    ensureCodexSubscriptionHome(root, TEAM, AGENT, 'sek');
    expect(existsSync(join(overlay, 'config.toml'))).toBe(false);
  });

  it('does NOT rewrite auth.json on an unchanged secret (codex refresh persists)', () => {
    const overlay = ensureCodexSubscriptionHome(root, TEAM, AGENT, 'orig');
    // Simulate codex refreshing the token in place mid-life.
    writeFileSync(join(overlay, 'auth.json'), 'REFRESHED-IN-PLACE');
    ensureCodexSubscriptionHome(root, TEAM, AGENT, 'orig');
    expect(readFileSync(join(overlay, 'auth.json'), 'utf8')).toBe(
      'REFRESHED-IN-PLACE',
    );
  });

  it('rewrites auth.json when the secret rotates', () => {
    const overlay = ensureCodexSubscriptionHome(root, TEAM, AGENT, 'orig');
    writeFileSync(join(overlay, 'auth.json'), 'REFRESHED-IN-PLACE');
    ensureCodexSubscriptionHome(root, TEAM, AGENT, 'ROTATED');
    expect(readFileSync(join(overlay, 'auth.json'), 'utf8')).toBe('ROTATED');
  });
});
