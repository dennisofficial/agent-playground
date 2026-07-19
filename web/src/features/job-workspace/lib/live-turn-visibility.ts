/**
 * A build thread's in-flight (streaming) turn is subscribed by the thread's STABLE lane
 * (`thread:<threadId>`), which every one of its per-Leg panes shares. So `useLiveTurn` hands the SAME
 * live-turn object to Leg 1, Leg 2, … alike. The durable transcript is sliced per Leg (via
 * `meta.legOrdinal`), but the live turn has no Leg identity — so without a gate every Leg pane would
 * paint the same live tail + "responding…" spinner at its bottom.
 *
 * This predicate is that gate: a per-Leg pane may render the live turn ONLY when it is the active
 * (live) Leg. Non-Leg lanes (Main, the whole-thread aggregate, codex review) pass `legOrdinal`
 * undefined and are always allowed — their behavior is unchanged.
 */
export function liveTurnVisibleForLeg(
  legOrdinal: number | undefined,
  legIsLive: boolean | undefined,
): boolean {
  return legOrdinal == null || legIsLive === true;
}
