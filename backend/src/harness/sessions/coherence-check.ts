import { escapeRegExp } from '../domain/text';

/**
 * Coherence canary: worker sessions are instructed to begin every prose report with their own
 * name. When the name drops out it's a cheap early signal that the session may be losing
 * coherence — context window pressure can silently erode instruction-following before output
 * quality visibly degrades.
 */

/**
 * Returns true if `text` begins with `name` — tolerant of leading whitespace and common Markdown
 * emphasis / quote / heading marks (so "**Alex**", "> Alex", "# Alex", "_Alex_" all pass),
 * case-insensitive.
 */
export const echoesOwnName = (text: string, name: string): boolean =>
  new RegExp('^[\\s>#*_~`-]*' + escapeRegExp(name), 'i').test(text);

/**
 * The note appended to a prose report that dropped the owner's name. Surfaces in the relay
 * prompt the conductor seeds on wake, in check_session output, and in the close-time worklog —
 * all via the existing `lastReport` field, with zero new plumbing.
 */
export const coherenceNote = (name: string): string =>
  `\n\n---\n⚠️ Coherence check: this reply didn't start with your name (${name}), which this session is instructed to always do — an early sign it may be losing coherence. Consider wrapping up and starting a fresh session if output quality is slipping.`;
