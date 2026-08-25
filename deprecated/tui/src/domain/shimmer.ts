/**
 * The working line's sweep, as arithmetic.
 *
 * A turn in flight has to be legible from across the room, and a one-cell spinner is not — it is a
 * single character twitching in a corner. So the light travels the WIDTH of the sentence: a crest
 * crosses the line left to right, rests, and comes back. Motion the size of the thing that is
 * moving, rather than motion the size of a cursor.
 *
 * Everything here is a pure function of the wall clock, so the line has no animation state to keep
 * and no frame to miss — a render at any instant computes the picture for that instant.
 */

export type ShimmerSpec = {
  /** Milliseconds the crest spends crossing one cell. Lower is faster. */
  speedMs: number;
  /** Half-width of the lit band, in cells. Heat is gone this far either side of the crest. */
  crestWidth: number;
  /**
   * The rest between sweeps, in MILLISECONDS rather than cells.
   *
   * Cells were the first cut and they are a trap: the pause then scales with the speed, so making
   * the sweep faster silently makes the rest shorter and the two knobs cannot be judged apart. A
   * pause is a duration.
   */
  quietMs: number;
};

/**
 * Tuned by eye against a live transcript, in `.scratch/working-animation.tsx`.
 *
 * The braille spinner in column 0 already owns the FAST channel, so the sweep takes the slow one: a
 * quick, narrow pass and then a long dark, ~2.5s apart. At that spacing each pass reads as a new
 * event rather than as a strobe you have to tune out while reading the transcript above it.
 */
export const WORKING_SHIMMER: ShimmerSpec = {
  speedMs: 18,
  crestWidth: 6,
  quietMs: 1500,
};

/** One pass plus the rest that follows it, in milliseconds. */
export function shimmerCycleMs(cells: number, spec: ShimmerSpec): number {
  return cells * spec.speedMs + spec.quietMs;
}

/**
 * Where the crest is now, in cells from column 0.
 *
 * During the rest this runs off the end of the line, which is exactly what makes it dark — the rest
 * needs no branch, it is just the crest being somewhere there is nothing to light.
 *
 * `cells` is the live width of the line, so a label that grows a character ("59s" → "1m 0s") shifts
 * the phase by at most one cell. That happens a handful of times a turn and is invisible; deriving
 * it from a fixed nominal width instead would leave a dead zone at the end of any longer line.
 */
export function shimmerCrest(
  nowMs: number,
  cells: number,
  spec: ShimmerSpec,
): number {
  const cycle = shimmerCycleMs(cells, spec);
  // Negative clocks are not a real input, but a modulo that can go negative would put the crest
  // behind the line and light nothing at all — a silent dead animation is worse than a clamp.
  const phase = ((nowMs % cycle) + cycle) % cycle;
  return phase / spec.speedMs;
}

/** How lit one column is: 1 under the crest, falling linearly to 0 `crestWidth` cells away. */
export function shimmerHeat(
  index: number,
  crest: number,
  spec: ShimmerSpec,
): number {
  return Math.max(0, 1 - Math.abs(index - crest) / spec.crestWidth);
}

/**
 * The icon's own flare, which is NOT `shimmerHeat` at column 0.
 *
 * The icon is the source the light leaves from, so it only fires on the outbound crest and decays
 * as the crest travels away; it never lights up again on the way back, because there is no way
 * back. Twice the crest width, so the flare outlasts the crest passing over the first word and the
 * two read as one gesture rather than as two things blinking near each other.
 */
export function beaconHeat(crest: number, spec: ShimmerSpec): number {
  return Math.max(0, 1 - crest / (spec.crestWidth * 2));
}
