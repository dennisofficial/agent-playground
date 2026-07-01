/**
 * Render a readable label from a track `brief`. The brief is free-form text written by the thread brain
 * at `submit_plan`; normally it leads with the track title (`"Title — detail…"`), and the narrow nav /
 * pipeline rows truncate it to the title. This also defensively de-JSONifies a brief that was persisted as
 * a raw `{"title":…,"details":…}` blob (older `submit_plan` runs serialized the whole object), so those
 * threads still show their title instead of JSON.
 */
export function threadTitle(brief: string): string {
  const t = (brief ?? '').trim();
  if (t.startsWith('{')) {
    try {
      const o = JSON.parse(t) as Record<string, unknown>;
      const title = typeof o.title === 'string' ? o.title.trim() : '';
      const detail =
        typeof o.details === 'string'
          ? o.details.trim()
          : typeof o.detail === 'string'
            ? o.detail.trim()
            : typeof o.description === 'string'
              ? o.description.trim()
              : '';
      return title || detail || t;
    } catch {
      return t;
    }
  }
  return t;
}
