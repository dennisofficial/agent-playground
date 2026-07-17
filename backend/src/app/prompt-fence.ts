/**
 * Prompt input FENCING. When we hand a model a piece of externally-sourced text — a proposed decision, a
 * diff, an operator message, a thread brief — we wrap it in a named `<tag>…</tag>` boundary so the model
 * sees an unambiguous edge between OUR instructions and ITS data. This is for clarity first (the model
 * knows exactly where the decision text / diff / message starts and ends, the idiomatic XML-tag prompt
 * shape) and injection-resistance second (text that's visibly fenced as data is much harder to mistake
 * for a directive).
 *
 * `fence` also strips any literal copies of its own open/close tags out of the body, so embedded text
 * can't forge the boundary to "break out" and pose as instructions — the same defense `wrapUntrusted`
 * applies to event bodies (see `stimulus/untrusted-content.ts`, the event-specific wrapper). Use THIS
 * for everything else.
 */

/** Wrap `body` in `<tag>…</tag>`, neutralizing any literal tags inside it so the boundary can't be forged. */
export function fence(tag: string, body: string): string {
  const open = `<${tag}>`;
  const close = `</${tag}>`;
  const safe = body.split(open).join('').split(close).join('');
  return `${open}\n${safe}\n${close}`;
}

/** Like {@link fence}, but emits `<tag>\n(none)\n</tag>` for empty/blank input so the section stays explicit. */
export function fenceOrNone(tag: string, body: string | null | undefined): string {
  return fence(tag, (body ?? '').trim() || '(none)');
}
