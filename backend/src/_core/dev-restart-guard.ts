import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * DEV-ONLY VISIBILITY: `nest start --watch` restarts the app on every successful recompile (a
 * `SIGTERM` to the old child, a fresh spawn). A BURST of restarts is invisible in the terminal — each
 * one just prints the normal boot banner — so a genuine restart STORM (e.g. two `pnpm dev` instances
 * racing for the same port, or a boot-time crash loop) looks identical to ordinary iteration until
 * something breaks. This incident already happened once: an Atlas job's plan-review turn was
 * interrupted mid-tool-call by a restart storm that ran for ~30 minutes and left the job wedged (see
 * the `atlas-plan-review-wedge-reconciler` memory). The wedge is now self-healing, but the storm itself
 * was never visible while it happened — this makes it loud.
 *
 * Appends this boot's timestamp to a small local JSON file (kept OUTSIDE `src/`, sibling to
 * `package.json`, so it can never be picked up by the TypeScript watch program) and warns if enough
 * boots landed within a short window. Best-effort in every direction: a missing/corrupt file, or a
 * write failure, never blocks or fails boot — this is a diagnostic, not a gate.
 */

export interface RestartGuardOptions {
  /** Where the boot-timestamp log lives. Defaults to `<cwd>/.dev-boot-log.json` (gitignored). */
  filePath?: string;
  /** How far back to look when counting recent boots. Default 30s. */
  windowMs?: number;
  /** Boots within `windowMs` at or above this count trips the warning. Default 5. */
  threshold?: number;
  /** How many timestamps to retain in the file (bounds its size). Default 20. */
  keep?: number;
  /** Injectable clock for tests. */
  now?: () => number;
}

export interface RestartGuardResult {
  /** Boots recorded within the window, INCLUDING this one. */
  recentCount: number;
  /** True when `recentCount >= threshold` — the caller should log a warning. */
  looksLikeAStorm: boolean;
  /** The window (ms) actually used — echoed back so the caller's warning text can't drift from the check. */
  windowMs: number;
}

/** Default lookback window — exported so callers rendering the warning never hardcode a second copy. */
export const DEFAULT_RESTART_WINDOW_MS = 30_000;

function readTimestamps(filePath: string): number[] {
  if (!existsSync(filePath)) return [];
  try {
    const parsed: unknown = JSON.parse(readFileSync(filePath, 'utf8'));
    return Array.isArray(parsed)
      ? parsed.filter((n) => typeof n === 'number')
      : [];
  } catch {
    return []; // corrupt/partial file (e.g. a concurrent writer) — treat as no history, never throw
  }
}

/**
 * Record this boot and report whether recent boot frequency looks like a restart storm. Pure w.r.t. its
 * inputs (the file path + injectable clock), so it's unit-testable without touching real dev state.
 */
export function checkRestartLoop(
  opts: RestartGuardOptions = {},
): RestartGuardResult {
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
    // Best-effort diagnostic only — a read/write failure (permissions, disk) must never fail boot.
    return { recentCount: 1, looksLikeAStorm: false, windowMs };
  }
}

/** The multi-line warning body, logged via the caller's logger so it matches normal boot-log formatting. */
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
