import { stripTags } from '../harness/tag-vocabulary';

export type RecalledForPrefix = { id: string; fact: string; scope: string };

const MIN_QUERY_CHARS = 12;
const MIN_QUERY_WORDS = 3;

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

export function isSubstantiveQuery(text: string): boolean {
  const t = text.trim();
  return t.length >= MIN_QUERY_CHARS && t.split(/\s+/).filter(Boolean).length >= MIN_QUERY_WORDS;
}
