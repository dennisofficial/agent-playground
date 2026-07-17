import type { EngineHomeKey } from '@workspace/agent-engine';
import { createHash } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { repoStateDir } from '../state-root';

export type { EngineHomeKey, EngineHomeType } from '@workspace/agent-engine';

export function atlasEngineHomeDir(
  root: string | undefined,
  engine: 'claude' | 'codex',
  key: EngineHomeKey,
): string {
  const dir = join(engineHomeLeaf(atlasAgentHomeBase(root), key), engine);
  mkdirSync(dir, { recursive: true });
  return dir;
}

export function atlasAgentHomeBase(root: string | undefined): string {
  return root ?? repoStateDir('agent-home');
}

export function engineHomeLeaf(base: string, key: EngineHomeKey): string {
  const parts = [safeHomeKey(key.orgId), safeHomeKey(key.repoId), safeHomeKey(key.jobId), key.type];
  if (key.subId) parts.push(safeHomeKey(key.subId));
  return join(base, ...parts);
}

export function engineHomeKeyString(key: EngineHomeKey): string {
  return [key.orgId, key.repoId, key.jobId, key.type, key.subId ?? ''].join(':');
}

export function safeHomeKey(part: string): string {
  const safe = part.replace(/[^a-z0-9_-]/gi, '_') || 'default';
  if (safe.length <= 40) return safe;
  const dash = safe.indexOf('-');
  const prefix = safe.slice(0, dash > 0 ? Math.min(dash, 12) : 12);
  return `${prefix}_${createHash('sha256').update(safe).digest('hex').slice(0, 12)}`;
}
