/** Compact human-readable byte size (e.g. `912 B`, `2 KB`, `9 KB`, `1.4 MB`). */
export function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${Math.round(n / 1024)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

/**
 * A friendly display label for the model a turn ran on — for the composer footer (`Opus 4.8`,
 * `Sonnet`, `Codex`). `model` is the raw id/alias from `turn_meta.usage` (may be absent — Codex turns
 * carry no model id); `engine` is the run's engine (`claude` | `codex`), used as the fallback so a
 * Codex turn still reads as "Codex" rather than blank. Returns null when neither is known (hide the
 * label). Kept as a small explicit map so the label matches the product design exactly rather than
 * echoing raw ids like `claude-opus-4-8`.
 */
export function formatModelLabel(model?: string, engine?: string): string | null {
  const id = model?.toLowerCase() ?? '';
  if (id.includes('opus')) return 'Opus 4.8';
  if (id.includes('sonnet')) return 'Sonnet';
  if (id.includes('haiku')) return 'Haiku';
  if (id.includes('gpt') || id.includes('codex') || id.includes('o3') || id.includes('o4'))
    return 'Codex';
  if (engine === 'codex') return 'Codex';
  if (engine === 'claude') return 'Claude';
  return null;
}

const EFFORT_LABELS: Record<string, string> = {
  minimal: 'Minimal',
  low: 'Low',
  medium: 'Medium',
  high: 'High',
  xhigh: 'xHigh',
  max: 'Max',
};

/** A friendly display label for a reasoning-effort value (`xhigh` → `xHigh`). Null when unset. */
export function formatEffort(effort?: string): string | null {
  if (!effort) return null;
  return EFFORT_LABELS[effort.toLowerCase()] ?? effort;
}
