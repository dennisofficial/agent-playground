/** The breadcrumb trail — `atlas › fix steering › builder · session 2`. */
export const TRAIL_SEPARATOR = ' › ';

export function joinTrail(segments: string[]): string {
  return segments.join(TRAIL_SEPARATOR);
}

/** Segments go from the FRONT, because the trail reads general → specific and the specific end is
 *  the part that says where you are. */
export function fitTrail(segments: string[], available: number): string {
  const kept = segments.filter((segment) => segment.length > 0);
  if (kept.length === 0) return '';

  let start = 0;
  while (start < kept.length - 1 && joinTrail(kept.slice(start)).length > available) start += 1;

  const text = joinTrail(kept.slice(start));
  if (text.length <= available) return text;
  return available <= 1 ? '…' : `${text.slice(0, available - 1)}…`;
}
