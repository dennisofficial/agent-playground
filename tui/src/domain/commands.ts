/**
 * Slash commands the composer RUNS, as opposed to the menu entries that only fill the draft.
 *
 * The distinction is the bug this exists to fix: the palette wrote `/rotate ` into the composer and
 * Enter then sent it to the agent as ordinary text, so every command in the menu was a suggestion
 * the model was free to ignore, misread or answer in prose. A command is a host act; it belongs to
 * Atlas, not to the conversation.
 *
 * Pure and in `domain/` because the parse is the whole decision — the page does exactly what this
 * returns, and that is testable without a terminal.
 */
export enum ESlashCommand {
  /** Ask the agent for its hand-off. Never a cut — see `rotationRequest`. */
  rotate = 'rotate',
}

/**
 * `/compact` is an ALIAS, not a command of its own.
 *
 * Auto-compaction is disabled outright (`autoCompactEnabled: false`) so that rotation owns context
 * with one mechanism rather than two competing for the same "context is full" event — and the SDK
 * rejects the command anyway ("not supported in this environment"), so the menu entry was dead. The
 * fingers that type it want the thing rotation does, only worse: compaction can compress a context
 * but it cannot externalise one.
 */
const ALIASES: Readonly<Record<string, ESlashCommand>> = {
  '/rotate': ESlashCommand.rotate,
  '/compact': ESlashCommand.rotate,
};

/**
 * The command a draft invokes, or `null` for anything else — including a slash command Atlas does
 * not run yet, which falls through to the agent exactly as it does today rather than being
 * swallowed by a palette that recognised it and did nothing.
 */
export function parseSlashCommand(draft: string): ESlashCommand | null {
  const [word] = draft.trim().split(/\s+/);
  if (!word || !word.startsWith('/')) return null;
  return ALIASES[word.toLowerCase()] ?? null;
}
