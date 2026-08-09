/**
 * Padded to `width`, or clipped to it with an ellipsis. Never longer, never shorter — a column that
 * comes back the wrong width shifts every column after it on that one row.
 *
 * The content gets `width - 1` cells, never all of them: a value that exactly fills its column runs
 * into the next one and reads as a single mangled word rather than as two columns.
 */
export function fitColumn(value: string, width: number): string {
  if (width <= 0) return '';
  const characters = [...value];
  if (characters.length < width) return value + ' '.repeat(width - characters.length);
  if (width === 1) return '…';
  return `${characters.slice(0, width - 2).join('')}… `;
}

/**
 * The same, clipped from the FRONT: `…/Developer/atlas`. For values whose meaning is at the end — a
 * column of clipped `/Users/dennis/Developer/…` says nothing about which project each row is.
 */
export function fitColumnEnd(value: string, width: number): string {
  if (width <= 0) return '';
  const characters = [...value];
  if (characters.length < width) return value + ' '.repeat(width - characters.length);
  if (width === 1) return '…';
  return `…${characters.slice(characters.length - (width - 2)).join('')} `;
}

export function elasticColumn(
  available: number,
  fixed: number,
  bounds: { min: number; max: number },
): number {
  return Math.min(bounds.max, Math.max(bounds.min, available - fixed));
}

export function affords(available: number, fixed: number, min: number): boolean {
  return available - fixed >= min;
}
