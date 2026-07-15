/**
 * Pure formatting + gating helpers for the memory auto-retrieval turn-prefix (d1/d2). Zero-dep and
 * container-safe like the rest of the hub — no NestJS, no I/O. The host-side `buildMemoryRecallPrefix`
 * composes these into the reserved `system_reminder source="memory"` slot.
 */

import { stripTags } from '../harness/tag-vocabulary';

export type RecalledForPrefix = { id: string; fact: string; scope: string };

// Trivial-message thresholds (d2): below either, we skip the embedding call so "ok"/"thanks" never fire.
const MIN_QUERY_CHARS = 12;
const MIN_QUERY_WORDS = 3;

/**
 * The memory-block body (inner text of the `<system_reminder source="memory">`). Empty input → '' so the
 * rule renders no chunk (byte-identical to a turn with no recall). No self-wrapping tag — the reserved slot
 * provides the boundary.
 */
export function renderMemoryRecall(facts: RecalledForPrefix[]): string {
  if (facts.length === 0) return '';
  const lines = facts
    .map((f) => ({
      id: f.id,
      text: stripTags(f.fact).replace(/\s+/g, ' ').trim(),
    }))
    .filter((f) => f.text)
    .map((f) => `  • [${f.id}] ${f.text}`);
  if (lines.length === 0) return '';
  return (
    'Relevant memories recalled for this message (semantic match; may be partial — verify before ' +
    `relying on them):\n${lines.join('\n')}\n` +
    'To correct or drop any of these, call update_memory({ id, fact }) to rewrite one, or ' +
    'forget({ id }) to delete one (use the [id] shown above).'
  );
}

/** Trivial-message guard (d2): skip acknowledgements so we don't embed "ok"/"thanks". */
export function isSubstantiveQuery(text: string): boolean {
  const t = text.trim();
  return (
    t.length >= MIN_QUERY_CHARS &&
    t.split(/\s+/).filter(Boolean).length >= MIN_QUERY_WORDS
  );
}
