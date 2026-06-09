/**
 * The slash-command plugin contract. Each command is a self-contained module implementing `Command`,
 * registered in the `COMMANDS` array (see `registry.ts`) and dispatched generically — mirroring the
 * project's other static registries (`ROSTER`, the engine registry, the board adapter). Adding a command
 * is one new module + one array entry; the dispatcher and `App.tsx` never change.
 *
 * `interface` matches the codebase convention for object shapes (e.g. gate.ts `GateDecision`/`Input`,
 * bot-graph.ts `BotStateDelta`); there is no biome/eslint rule here (Prettier-only).
 */

/**
 * The UI capabilities a command may need — the only React/Ink-scoped seam. Commands reach the conductor,
 * board, and tasks by direct import (the singleton convention used throughout the codebase), so this stays
 * intentionally minimal (ISP): just the things a command CAN'T import because they live in the component.
 */
export interface CommandContext {
  /** Print a local-only transcript row (RenderItem kind:'note') — CLI output, never a channel message. */
  note(text: string): void;
  /** Quit the app (Ink `useApp().exit`). */
  exit(): void;
}

export interface Command {
  /** Invocation word + one-line help — metadata for a future `/help`/placeholder; NOT used for dispatch. */
  readonly name: string;
  readonly summary: string;
  /**
   * Try to handle `text`. Return `true` if THIS command recognized AND handled it; `false` to DECLINE
   * (the dispatcher then tries the next command, and finally the caller falls through to channel submit).
   * Each command copies its ORIGINAL exact-string / regex condition verbatim — so recognition,
   * required-args, and case behavior are byte-for-byte unchanged from the old `App.tsx` ladder.
   * Synchronous: every conductor method it calls returns synchronously.
   */
  run(text: string, ctx: CommandContext): boolean;
}
