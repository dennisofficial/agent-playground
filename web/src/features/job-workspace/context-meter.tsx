import { formatTokens } from "@/lib/org-display";

/**
 * A context-window occupancy ring (Claude-Code style) — a small SVG arc + center %. `tokens` is the last
 * turn's input-token count (≈ what's resident in context); `limit` is the model's window. Turns amber/red
 * as it fills. The model/limit come from the latest `turn_meta` block, so it threads whatever model ran.
 * `size` scales the ring for tighter surfaces (e.g. a subagent card) while keeping the same arc geometry.
 */
export function ContextMeter({
  tokens,
  limit,
  model,
  size = 17,
}: {
  tokens: number;
  limit: number;
  model?: string;
  size?: number;
}) {
  const pct = limit > 0 ? Math.min(1, Math.max(0, tokens / limit)) : 0;
  const r = 7;
  const circ = 2 * Math.PI * r;
  const stroke =
    pct >= 0.9
      ? "var(--red)"
      : pct >= 0.7
        ? "var(--accent-2)"
        : "var(--accent)";
  return (
    <div
      className="flex items-center gap-1.5 px-1"
      title={`Context · ${formatTokens(tokens)} / ${formatTokens(limit)} (${Math.round(pct * 100)}%)${model ? ` · ${model}` : ""}`}
    >
      <svg width={size} height={size} viewBox="0 0 18 18" className="-rotate-90">
        <circle
          cx="9"
          cy="9"
          r={r}
          fill="none"
          stroke="var(--border)"
          strokeWidth="2.2"
        />
        <circle
          cx="9"
          cy="9"
          r={r}
          fill="none"
          stroke={stroke}
          strokeWidth="2.2"
          strokeLinecap="round"
          strokeDasharray={`${circ * pct} ${circ}`}
        />
      </svg>
      <span className="font-mono text-[10px] tabular-nums text-dim">
        {Math.round(pct * 100)}%
      </span>
    </div>
  );
}
