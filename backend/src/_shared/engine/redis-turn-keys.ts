export interface TurnKeys {
  /** Host → engine, written once: the `TurnSpec` frame the engine reads at boot. */
  spec: string;
  /** Engine → host, appended over the run: SDK events for the realtime feed. */
  events: string;
}

export function turnKeys(turnId: string): TurnKeys {
  const base = `turn:${turnId}`;
  return {
    spec: `${base}:spec`,
    events: `${base}:events`,
  };
}
