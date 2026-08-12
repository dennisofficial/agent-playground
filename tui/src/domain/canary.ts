/**
 * The context canary.
 *
 * `⟡` is a standing instruction the agent is told to open every message with, and Atlas watches it
 * for its **absence** — a session that has stopped emitting it has stopped following a simple
 * standing instruction, which is the cheapest available reading of context rot. That makes the glyph
 * an instrument rather than decoration, and an instrument has two hard requirements:
 *
 * - it must survive **untouched in the store**, because a stripper that wrote through would destroy
 *   the very signal it exists to measure and the absence would become unobservable; and
 * - it must never reach a **reader** — not the transcript, not `atlas transcript`, not a hand-off
 *   quoted into the next session — because a glyph on every line is noise to a human and, worse,
 *   an example the next agent will copy for the wrong reason.
 *
 * So: strip at render, every time, and never on the way in.
 */
export const CANARY = '⟡';

/**
 * Drop a LEADING canary and the whitespace it sits on.
 *
 * Leading only, deliberately: a glyph inside prose is content — an agent quoting the instruction, a
 * decision doc discussing the instrument — and rewriting it would be a renderer editing what was
 * said. Position is the whole of the rule because position is the whole of the instruction.
 *
 * Idempotent, and a no-op on text that never carried one, so a caller never has to ask whether it
 * has already been applied. Only ONE canary comes off: `⟡ ⟡ hello` renders as `⟡ hello`, which is
 * visibly wrong in the direction that gets noticed rather than silently swallowing a repetition.
 */
export function stripCanary(text: string): string {
  const start = text.trimStart();
  if (!start.startsWith(CANARY)) return text;
  return start.slice(CANARY.length).trimStart();
}

/**
 * The reading, and the exact inverse of the stripper: whether this message opened with the glyph.
 *
 * It must be given the message as the agent WROTE it — the stored text, never the rendered text.
 * Every prose surface strips the canary on its way to a screen, so a watcher pointed at rendered
 * text would observe 100% absence and report a session dead from its first turn.
 */
export function hasCanary(text: string): boolean {
  return text.trimStart().startsWith(CANARY);
}

/**
 * How the instrument reads, as a RATE rather than a bit.
 *
 * One missed glyph is a model having a moment; three in five turns is a session that has stopped
 * reliably following a standing instruction it was given at the top of every request — which is the
 * cheapest available reading of context rot, and the only one that works on an engine with no
 * telemetry at all. It also measures whether nudging still works: the instruction to rotate is a
 * standing instruction too, so a dead canary is a session that may not act on being asked.
 */
export enum ECanaryHealth {
  /** Too few turns to say anything. Not a clean bill of health. */
  unknown = 'unknown',
  alive = 'alive',
  /** Missing, but not yet reliably — worth showing, not worth acting on. */
  dying = 'dying',
  dead = 'dead',
}

/** Turns considered. Long enough that one lapse is not a verdict, short enough to notice a change. */
const CANARY_WINDOW = 5;
const DEAD_MISSES = 3;

/** `samples` is one entry per turn, oldest first: did that turn's first message carry the glyph. */
export function canaryHealth(samples: readonly boolean[]): ECanaryHealth {
  const window = samples.slice(-CANARY_WINDOW);
  if (window.length < DEAD_MISSES) return ECanaryHealth.unknown;
  const misses = window.filter((present) => !present).length;
  if (misses >= DEAD_MISSES) return ECanaryHealth.dead;
  return misses === 0 ? ECanaryHealth.alive : ECanaryHealth.dying;
}
