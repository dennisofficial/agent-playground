import { createHash } from 'node:crypto';
import {
  existsSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { engineHomeDir } from './engine-home';

/**
 * The per-(team,agent) codex home that drives a workspace's OWN ChatGPT subscription instead of a
 * metered API key. Subscription credentials are per-TEAM (each workspace's own `codex login`), but
 * the engine home (skills/MCP/config.toml) is per-EMPLOYEE — so a subscription turn runs in an
 * OVERLAY home that:
 *  - SYMLINKS the provisioner-owned `config.toml` (MCP) + `AGENTS.md` (skills) from the canonical
 *    per-agent home, so reconciled MCP/skill state propagates live (no per-team re-materialization), and
 *  - OWNS `auth.json` — written from the stored secret on first use and on rotation (the secret
 *    changed), but NOT on every turn, so codex's in-place token refresh persists across turns.
 *
 * DB-free and dependency-light (only `engine-home`), so the daemon image imports it unchanged — the
 * same `CodexEngine` class runs on both host and daemon.
 */

/** Files owned by the provisioner / daemon-prime in the canonical home, symlinked into the overlay. */
const MIRRORED = ['config.toml', 'AGENTS.md'] as const;

const AUTH_FILE = 'auth.json';
/** Stores the hash of the SECRET that produced auth.json — detects a rotated credential without
 * diffing the live auth.json (which codex mutates in place on token refresh). */
const AUTH_SOURCE = '.auth-source';

/** Ensure the overlay home exists + is current, and return its path (use as CODEX_HOME). Idempotent
 * and cheap — safe to call every turn (refreshes the symlinks and handles credential rotation). */
export function ensureCodexSubscriptionHome(
  root: string | undefined,
  team: string,
  agentId: string,
  secret: string,
): string {
  // engineHomeDir sanitizes (allows `_`) and mkdir -p's both dirs.
  const canonical = engineHomeDir(root, 'codex', agentId);
  const overlay = engineHomeDir(root, 'codex', `${team}__${agentId}`);

  // Re-link each mirrored file every turn so provisioner updates (and removals) are reflected.
  for (const name of MIRRORED) {
    const link = join(overlay, name);
    const target = join(canonical, name);
    rmSync(link, { force: true });
    if (existsSync(target)) symlinkSync(target, link);
  }

  // Write auth.json only on first use / rotation — never clobber a refreshed token mid-life.
  const hash = createHash('sha256').update(secret).digest('hex');
  const marker = join(overlay, AUTH_SOURCE);
  const seen = existsSync(marker) ? readFileSync(marker, 'utf8') : undefined;
  if (seen !== hash) {
    writeFileSync(join(overlay, AUTH_FILE), secret, { mode: 0o600 });
    writeFileSync(marker, hash, { mode: 0o600 });
  }
  return overlay;
}
