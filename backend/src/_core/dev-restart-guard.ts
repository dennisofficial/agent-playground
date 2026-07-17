import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';


export interface RestartGuardOptions {
  filePath?: string;
  windowMs?: number;
  threshold?: number;
  keep?: number;
  now?: () => number;
}

export interface RestartGuardResult {
  recentCount: number;
  looksLikeAStorm: boolean;
  windowMs: number;
}

export const DEFAULT_RESTART_WINDOW_MS = 30_000;

function readTimestamps(filePath: string): number[] {
  if (!existsSync(filePath)) return [];
  try {
    const parsed: unknown = JSON.parse(readFileSync(filePath, 'utf8'));
    return Array.isArray(parsed) ? parsed.filter((n) => typeof n === 'number') : [];
  } catch {
    return []; // corrupt/partial file (e.g. a concurrent writer) — treat as no history, never throw
  }
}

export function checkRestartLoop(opts: RestartGuardOptions = {}): RestartGuardResult {
  const {
    filePath = join(process.cwd(), '.dev-boot-log.json'),
    windowMs = DEFAULT_RESTART_WINDOW_MS,
    threshold = 5,
    keep = 20,
    now = Date.now,
  } = opts;

  try {
    const t = now();
    const history = [...readTimestamps(filePath), t];
    const trimmed = history.slice(-keep);
    writeFileSync(filePath, JSON.stringify(trimmed));
    const recentCount = trimmed.filter((ts) => t - ts < windowMs).length;
    return { recentCount, looksLikeAStorm: recentCount >= threshold, windowMs };
  } catch {
    return { recentCount: 1, looksLikeAStorm: false, windowMs };
  }
}

export function renderRestartStormWarning(result: RestartGuardResult): string {
  const windowMs = result.windowMs;
  return (
    `⚠️  ${result.recentCount} boots within the last ${Math.round(windowMs / 1000)}s — this looks like a restart ` +
    'storm, not ordinary `nest --watch` iteration. Likely causes: (1) TWO dev-server instances racing for the ' +
    'same port (check `lsof -i :<HTTP_PORT>` / `ps aux | grep "nest start"` for duplicates and stop the extra ' +
    'one), or (2) a boot-time crash loop (check the log just above for a repeating fatal error). A storm like ' +
    'this can interrupt a long-running in-flight turn (e.g. a synchronous Codex review) on every restart — see ' +
    'the plan-review wedge-reconciler incident.'
  );
}
