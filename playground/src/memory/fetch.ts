import type { Bot } from '../roster.js';
import { getDb } from './db.js';
import { type Identity, recallScopes } from './identity.js';
import { recall } from './semantic.js';
import { openTasks } from './tasks.js';

/**
 * The pre-LLM memory FETCH — the read half of deterministic memory. Before a bot thinks, this pulls the
 * facts + open tasks relevant to what's being said and hands them back as a `recalled` block the graph
 * injects into the model's context. So the bot always walks in knowing, instead of (un)reliably choosing
 * to call `recall` itself. Each half has a cheap programmatic skip so an empty store costs nothing.
 */

/** Programmatic empty-skip: does this identity have ANY live fact in its recall scopes? */
function hasFacts(id: Identity): boolean {
  const scopes = recallScopes(id);
  if (scopes.length === 0) return false;
  const placeholders = scopes.map(() => '?').join(',');
  const row = getDb()
    .prepare(`SELECT 1 FROM facts WHERE scope IN (${placeholders}) AND deleted_at IS NULL LIMIT 1`)
    .get(...scopes);
  return !!row;
}

/**
 * Build the `recalled` context block for `bot`, given this turn's incoming text as the retrieval query.
 * Facts: embedding top-k via `recall` (skipped when the store is empty). Tasks: the open board for this
 * bot + unassigned (skipped when there are none). Returns '' when there's nothing — the caller MUST still
 * write that empty string into state so a stale recall from a prior turn never lingers.
 */
export async function fetchContext(bot: Bot, query: string, id: Identity): Promise<string> {
  const parts: string[] = [];

  if (query.trim() && hasFacts(id)) {
    const facts = await recall(query, id);
    if (facts.length > 0) {
      parts.push(`What you already know:\n${facts.map((f) => `- ${f.fact}`).join('\n')}`);
    }
  }

  const mine = openTasks(id.company).filter((t) => !t.assignee || t.assignee === bot.id);
  if (mine.length > 0) {
    parts.push(
      `Open tasks:\n${mine
        .map((t) => `- [#${t.id}] ${t.description}${t.assignee ? '' : ' (unassigned)'}`)
        .join('\n')}`,
    );
  }

  return parts.join('\n\n');
}
