import type { ClaudeUsageWindowKey, ModelUsageWindow, StoredUsageWindow } from '@workspace/shared';

/** Anthropic `rate_limit_event` types → our window keys. */
export const RATE_LIMIT_TYPE_TO_WINDOW: Record<string, ClaudeUsageWindowKey> = {
  five_hour: 'fiveHour',
  seven_day: 'sevenDay',
  seven_day_opus: 'sevenDayOpus',
  seven_day_sonnet: 'sevenDaySonnet',
};

export type ParsedUsage = {
  windows: Partial<Record<ClaudeUsageWindowKey, StoredUsageWindow>>;
  modelWindows: ModelUsageWindow[];
};

/** Normalize a utilization to an integer 0–100, accepting either a 0–1 fraction or a 0–100 percent. */
export function toPercentUtilization(utilization: number | undefined): number | undefined {
  if (utilization == null) return undefined;
  const percent = utilization <= 1 ? utilization * 100 : utilization;
  return Math.round(Math.min(100, Math.max(0, percent)));
}

/** Epoch (s or ms) → ISO, or undefined when absent/invalid. */
export function resetEpochToIso(resetsAt: number | undefined | null): string | undefined {
  if (resetsAt == null) return undefined;
  const ms = resetsAt < 1e12 ? resetsAt * 1000 : resetsAt;
  const d = new Date(ms);
  return Number.isNaN(d.getTime()) ? undefined : d.toISOString();
}

function parseWindow(raw: unknown): StoredUsageWindow | null {
  if (!raw || typeof raw !== 'object') return null;
  const w = raw as { utilization?: unknown; resets_at?: unknown };
  const utilization = typeof w.utilization === 'number' ? w.utilization : null;
  if (utilization == null) return null;
  const resetsAtMs =
    typeof w.resets_at === 'string' || typeof w.resets_at === 'number'
      ? new Date(w.resets_at).getTime()
      : NaN;
  if (Number.isNaN(resetsAtMs)) return null;
  return {
    utilization: Math.round(Math.min(100, Math.max(0, utilization))),
    resetsAt: new Date(resetsAtMs).toISOString(),
  };
}

/** Per-model weekly caps from the usage API `limits[]` (`weekly_scoped` entries, e.g. "Fable"). */
export function parseModelWindows(root: Record<string, unknown>): ModelUsageWindow[] {
  const limits = root.limits;
  if (!Array.isArray(limits)) return [];
  const out: ModelUsageWindow[] = [];
  for (const raw of limits) {
    if (!raw || typeof raw !== 'object') continue;
    const l = raw as { kind?: unknown; percent?: unknown; resets_at?: unknown; scope?: unknown };
    if (l.kind !== 'weekly_scoped') continue;
    const label = (l.scope as { model?: { display_name?: unknown } } | undefined)?.model
      ?.display_name;
    if (typeof label !== 'string' || label.length === 0) continue;
    if (typeof l.percent !== 'number') continue;
    out.push({
      label,
      utilization: Math.round(Math.min(100, Math.max(0, l.percent))),
      resetsAt: typeof l.resets_at === 'string' ? l.resets_at : null,
    });
  }
  return out;
}

/** Parse the `/api/oauth/usage` response into flat windows + per-model weekly caps. */
export function parseUsageResponse(body: unknown): ParsedUsage {
  const root = (body ?? {}) as Record<string, unknown>;
  const nested =
    (root.windows as Record<string, unknown> | undefined) ??
    (root.rate_limits as Record<string, unknown> | undefined) ??
    {};
  const pick = (key: string): unknown => root[key] ?? nested[key];
  const windows: ParsedUsage['windows'] = {};
  const assign = (key: ClaudeUsageWindowKey, raw: unknown): void => {
    const w = parseWindow(raw);
    if (w) windows[key] = w;
  };
  assign('fiveHour', pick('five_hour'));
  assign('sevenDay', pick('seven_day'));
  assign('sevenDayOpus', pick('seven_day_opus'));
  assign('sevenDaySonnet', pick('seven_day_sonnet'));
  return { windows, modelWindows: parseModelWindows(root) };
}
