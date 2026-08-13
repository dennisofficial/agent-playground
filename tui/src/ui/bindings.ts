import { ALT } from "./theme.js";

/** One row of the shortcuts panel: what to press, and what it does. */
export type Binding = readonly [key: string, does: string];

export const GLOBAL: readonly Binding[] = [
  ["ctrl+a", "accounts"],
  ["ctrl+c", "quit"],
];

/** Projects, jobs, accounts — the same five keys drive all three. */
export const LISTS: readonly Binding[] = [
  ["↑ ↓", "move"],
  ["→ · ⏎", "open"],
  ["/", "filter"],
  ["n", "new"],
  ["x", "delete"],
  ["← · esc", "back"],
];

export const CONVERSATION: readonly Binding[] = [
  ["⏎", "send · queue steer"],
  [`shift+⏎ · ${ALT}+⏎`, "newline"],
  ["esc", "interrupt · clear"],
  ["←", "leave"],
  ["ctrl+u", "clear draft"],
  ["ctrl+h", "threads"],
  // `ctrl+y` (the pending proposal) is NOT listed either, for the same two reasons as `ctrl+b`
  // below: the panel has no row to spare at 60×24, and the line that appears when a proposal is
  // waiting spells the key itself — at the only moment it means anything.
  // `ctrl+b` (jump to bottom) is deliberately NOT listed: a seventeenth row does not fit 60×24, and
  // the affordance that appears when you are scrolled away spells the key itself, at the only
  // moment it means anything.
  ["/", "commands"],
  // Wheel and trackpad only. PgUp/PgDn used to be listed here and never worked: they reached the
  // transcript only while it held focus, which also handed it ↑/↓ and scrolled the page under the
  // caret. The keyboard belongs to the draft — see the scrollbox in `pages/conversation.tsx`.
  // Paired, because a seventeenth row does not fit a 60×24 window (the panel wraps rather than
  // shaving, and a wrapped keymap is worse than a terse one) — and because both halves are the same
  // fact: the mouse drives the transcript, the keyboard drives the draft.
  ["wheel · drag", "scroll · copies"],
  [`${ALT}+wheel`, "pan a wide block"],
];

/** Only shown where there is a draft to edit, and only the keys a terminal reliably delivers. */
export const EDITING: readonly Binding[] = [
  [`${ALT}+← →`, "by word"],
  [`${ALT}+⌫ · ctrl+w`, "rub out a word"],
  ["ctrl+k", "to end of line"],
  ["Home End", "line start · end"],
];
