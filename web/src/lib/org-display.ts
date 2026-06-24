/**
 * Presentation helpers for organizations — deterministic color + initials so the same org always
 * renders the same swatch across the rail, the board, and the settings header. Colors are CSS-variable
 * names (theme-aware): the swatch recolors for free on a theme swap.
 */

/** The org swatch palette (theme tokens). Owners and joined orgs both draw from it; assignment is by id. */
const ORG_COLORS = ['var(--accent)', 'var(--blue)', 'var(--purple)', 'var(--green)', 'var(--rose)'] as const;

/** Stable hash → palette index, so an org id always maps to the same color. */
export function orgColor(orgId: string): string {
  let h = 0;
  for (let i = 0; i < orgId.length; i++) h = (h * 31 + orgId.charCodeAt(i)) | 0;
  return ORG_COLORS[Math.abs(h) % ORG_COLORS.length];
}

/** 1–2 letter avatar initials from an org name (first letters of the first two words, else first two chars). */
export function orgInitials(name: string): string {
  const parts = (name || '').trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return '?';
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
  return (parts[0][0] + parts[1][0]).toUpperCase();
}

/** A short, lowercase role label for chips (`owner` / `member`). */
export function roleLabel(role: string): string {
  return (role || 'member').toLowerCase();
}

/** Compact relative time ("just now", "5m", "3h", "2d", "Apr 9") from an ISO timestamp. */
export function timeAgo(iso: string): string {
  const then = new Date(iso).getTime();
  if (Number.isNaN(then)) return '';
  const s = Math.max(0, Math.floor((Date.now() - then) / 1000));
  if (s < 45) return 'just now';
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h`;
  const d = Math.floor(h / 24);
  if (d < 7) return `${d}d`;
  return new Date(then).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

/** Slugify an org name into a URL-safe handle (mirrors the backend's `slugifyName`). */
export function slugify(name: string): string {
  return (
    (name || '')
      .toLowerCase()
      .trim()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 48) || 'org'
  );
}
