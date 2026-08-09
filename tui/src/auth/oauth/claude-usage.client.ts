import { Injectable, Logger } from "@nestjs/common";
import type { UsageWindow } from "../../domain/usage.js";

/**
 * `GET /api/oauth/usage` — the only source of a real 5-hour / 7-day percentage.
 *
 * The obvious-looking source, the SDK's `rate_limit_event` frames, does NOT carry one: the frames
 * Atlas actually receives hold `status`, `resetsAt` and `rateLimitType` and no `utilization` at all,
 * so harvesting them alone leaves both meters at `—` forever. This is the same endpoint the
 * backend's `AgentUsageService` polls and the same one `claude /usage` reads. It needs the
 * `user:profile` scope, which the login flow already requests.
 *
 * Ported rather than imported, like `ClaudeOAuthClient` above it — the TUI is standalone, and this
 * is one HTTP round-trip. Constants are public values, so they live in code rather than env.
 */
const USAGE_URL = "https://api.anthropic.com/api/oauth/usage";
const OAUTH_BETA_HEADER = "oauth-2025-04-20";
/** The endpoint expects the Claude Code CLI's User-Agent. Bump alongside the SDK if it starts 4xx-ing. */
const CLAUDE_CODE_VERSION = "2.1.204";
const FETCH_TIMEOUT_MS = 10_000;

export type ClaudeUsageWindows = {
  fiveHour: UsageWindow;
  sevenDay: UsageWindow;
};

@Injectable()
export class ClaudeUsageClient {
  private readonly logger = new Logger(ClaudeUsageClient.name);

  /** `null` means the CALL failed; a null window inside means the plan has no such window. */
  async fetch(accessToken: string): Promise<ClaudeUsageWindows | null> {
    try {
      const response = await fetch(USAGE_URL, {
        headers: {
          authorization: `Bearer ${accessToken}`,
          "anthropic-beta": OAUTH_BETA_HEADER,
          "user-agent": `claude-code/${CLAUDE_CODE_VERSION}`,
          "content-type": "application/json",
        },
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      });
      if (!response.ok) {
        this.logger.warn(`usage fetch failed: HTTP ${response.status}`);
        return null;
      }
      return this.parse(await response.json());
    } catch (error) {
      // A meter is decoration. Losing it must never take a turn — or opening a thread — down.
      this.logger.warn(`usage fetch error: ${String(error)}`);
      return null;
    }
  }

  /** Two meters out; every weekly variant folds onto `wk`. */
  parse(body: unknown): ClaudeUsageWindows {
    const root = (body ?? {}) as Record<string, unknown>;
    return {
      fiveHour: readWindow(root.five_hour),
      sevenDay: nearestWall(
        [root.seven_day, root.seven_day_opus, root.seven_day_sonnet].map(
          readWindow,
        ),
      ),
    };
  }
}

/**
 * This endpoint states utilisation as 0..100 already, so `toPercent`'s 0..1-or-0..100 heuristic must
 * NOT be applied here — it would read a genuine 1% as a full window.
 */
function readWindow(raw: unknown): UsageWindow {
  if (!raw || typeof raw !== "object") return null;
  const window = raw as { utilization?: unknown; resets_at?: unknown };
  if (typeof window.utilization !== "number") return null;
  return {
    utilization: Math.round(Math.min(100, Math.max(0, window.utilization))),
    resetsAt: typeof window.resets_at === "string" ? window.resets_at : null,
  };
}

/** One `wk` meter, several weekly windows: show the one closest to stopping the work. */
function nearestWall(windows: UsageWindow[]): UsageWindow {
  return windows.reduce<UsageWindow>(
    (worst, window) =>
      window && (!worst || window.utilization > worst.utilization)
        ? window
        : worst,
    null,
  );
}
