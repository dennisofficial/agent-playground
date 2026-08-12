/**
 * What a job is called, read off the words that started it.
 *
 * The title used to be typed before the job existed, which charged ceremony for a thought you had
 * not finished having — and then the title was injected as the opening message anyway, so you paid
 * twice for one sentence. Now the first message is the only input, and the name is derived from it.
 *
 * Pure and deterministic, deliberately NOT a model call: naming is not worth a round trip, and a
 * job must never wait on an engine to come into existence. A model-written title, if it is ever
 * wanted, belongs on the rename path — after the job exists — not in front of it.
 */

/** `TITLE.max` in `jobs-list.ts`: the widest a row ever draws, so a longer title is never read. */
const MAX = 56;

/** Nothing said, or nothing sayable — a row still needs a word to draw. */
const FALLBACK = "untitled job";

/**
 * Markdown furniture at the head of a line. Stripped rather than kept because the first line of a
 * message is very often `## something` or `- something`, and the marker names the formatting, not
 * the job. A trailing `:` goes with them: `bug:` heads a paragraph, it does not title one.
 */
const LEADING = /^\s*(?:[#>]{1,6}\s+|[-*+]\s+|\d+[.)]\s+)/;

export function deriveJobTitle(text: string): string {
  for (const line of text.split("\n")) {
    const cleaned = clean(line);
    // A line of pure punctuation — a fence, a rule, a bare bullet — names nothing, so keep looking
    // rather than titling the job `---`.
    if (!/[\p{L}\p{N}]/u.test(cleaned)) continue;
    return cut(cleaned);
  }
  return FALLBACK;
}

function clean(line: string): string {
  return line.replace(LEADING, "").replace(/\s+/g, " ").trim().replace(/:$/, "");
}

/**
 * Truncation stops at a word, not mid-word: a title is scanned, and half a word at the end reads as
 * a rendering bug rather than as more text. The hard cut is the fallback for one long token.
 */
function cut(title: string): string {
  const characters = [...title];
  if (characters.length <= MAX) return title;

  const head = characters.slice(0, MAX - 1).join("");
  const space = head.lastIndexOf(" ");
  // Only break at a space that leaves a title worth reading — a break at column three would name
  // the job after its first word.
  const kept = space > MAX / 3 ? head.slice(0, space) : head.trimEnd();
  return `${kept}…`;
}
