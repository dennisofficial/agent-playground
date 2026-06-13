// TODO: import Tier from @workspace/shared once Alex's migration pass lands.
export type Tier = 'team' | 'project' | 'bot' | 'private';

export const TIER_ORDER: Tier[] = ['project', 'team', 'bot', 'private'];

export const TIER_LABEL: Record<Tier, string> = {
  project: 'Project',
  team: 'Team',
  bot: 'Bot',
  private: 'Private',
};

/**
 * Tailwind classes for each tier's inline badge pill. Uses a distinct color per tier so the
 * eye can scan without reading — matches the zinc design system in the rest of the admin UI.
 */
export const TIER_BADGE_CLASS: Record<Tier, string> = {
  project:
    'bg-violet-100 text-violet-700 dark:bg-violet-900/40 dark:text-violet-300',
  team: 'bg-blue-100 text-blue-700 dark:bg-blue-900/40 dark:text-blue-300',
  bot: 'bg-emerald-100 text-emerald-700 dark:bg-emerald-900/40 dark:text-emerald-300',
  private:
    'bg-amber-100 text-amber-700 dark:bg-amber-900/40 dark:text-amber-300',
};

const RTF = new Intl.RelativeTimeFormat('en', { numeric: 'auto' });

const THRESHOLDS: { unit: Intl.RelativeTimeFormatUnit; ms: number }[] = [
  { unit: 'year', ms: 365 * 24 * 60 * 60 * 1000 },
  { unit: 'month', ms: 30 * 24 * 60 * 60 * 1000 },
  { unit: 'week', ms: 7 * 24 * 60 * 60 * 1000 },
  { unit: 'day', ms: 24 * 60 * 60 * 1000 },
  { unit: 'hour', ms: 60 * 60 * 1000 },
  { unit: 'minute', ms: 60 * 1000 },
];

/** Human-readable relative time from an ISO timestamp. Falls back to the ISO string on parse error. */
export function relativeTime(iso: string): string {
  const date = new Date(iso);
  if (isNaN(date.getTime())) return iso;
  const diffMs = date.getTime() - Date.now();
  for (const { unit, ms } of THRESHOLDS) {
    if (Math.abs(diffMs) >= ms) {
      return RTF.format(Math.round(diffMs / ms), unit);
    }
  }
  return RTF.format(Math.round(diffMs / 1000), 'second');
}
