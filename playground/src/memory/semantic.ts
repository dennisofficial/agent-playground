import { getDb } from './db.js';
import { cosine, embed } from './embeddings.js';
import { type Identity, recallScopes, scopeForTier, type Tier } from './identity.js';

/**
 * Self-managed semantic memory — `remember` / `recall` / `update` / `forget` over distilled facts,
 * stored at one of three sharing tiers (see identity.ts). The tier is the abstraction boundary; a
 * vector index or Hindsight could drop in behind these without touching callers.
 */
export interface StoredFact {
  id: number;
  fact: string;
  scope: string;
  asserted_by: string | null;
  source_surface: string | null;
  confidence: number;
  created_at: string;
  updated_at: string;
}

type Row = StoredFact & { embedding: string };

// Cosine above this, within the same scope, means "the same fact" → update in place, not a duplicate.
export const DEDUP_THRESHOLD = 0.92;
// Below the auto-merge bar but close enough to be a likely paraphrase. A candidate landing in
// [GRAY_FLOOR, DEDUP_THRESHOLD) is sent to the injected judge (when one is supplied) rather than
// blindly inserted — paraphrases sit here (~0.85–0.91), but so can adjacent-but-distinct facts, so a
// judge (not the threshold) makes the call. Anything below GRAY_FLOOR is treated as genuinely new.
export const GRAY_FLOOR = 0.82;

const nowIso = () => new Date().toISOString();
const parseEmb = (s: string): number[] => JSON.parse(s) as number[];
const stripEmb = ({ embedding: _embedding, ...rest }: Row): StoredFact => rest;

export interface RememberInput {
  fact: string;
  /** Which sharing tier to store at. */
  tier: Tier;
  /** The active identity — resolves the tier to a concrete scope and provides provenance. */
  id: Identity;
}

export interface RememberOpts {
  /**
   * Gray-zone tiebreaker: given an EXISTING fact and the CANDIDATE being stored, returns true when
   * they're the same underlying fact (→ merge into that row) and false when they differ in meaning.
   * Injected (not imported) so this module stays pure DB + embeddings — the LLM lives in dedup.ts.
   */
  judge?: (existing: string, candidate: string) => Promise<boolean>;
}

/**
 * Store a fact at its tier's scope, or merge it into an existing near-duplicate in that scope
 * (dedup-on-upsert). A candidate at cosine ≥ DEDUP_THRESHOLD merges outright; one in the gray band
 * [GRAY_FLOOR, DEDUP_THRESHOLD) merges only if the injected `judge` confirms it's the same fact —
 * candidates are walked most-similar-first so an adjacent-but-distinct nearest neighbor can't hide a
 * lower-sim true duplicate behind it.
 */
export async function remember(
  input: RememberInput,
  opts: RememberOpts = {},
): Promise<{ action: 'inserted' | 'updated'; id: number }> {
  const db = getDb();
  const vec = await embed(input.fact);
  const scope = scopeForTier(input.tier, input.id);
  const ts = nowIso();

  const mergeInto = (id: number): { action: 'updated'; id: number } => {
    db.prepare(`UPDATE facts SET fact = ?, embedding = ?, updated_at = ? WHERE id = ?`).run(
      input.fact,
      JSON.stringify(vec),
      ts,
      id,
    );
    return { action: 'updated', id };
  };

  // Every same-scope fact near enough to be a candidate duplicate, most-similar first.
  const candidates = (
    db
      .prepare(`SELECT id, fact, embedding FROM facts WHERE scope = ? AND deleted_at IS NULL`)
      .all(scope) as { id: number; fact: string; embedding: string }[]
  )
    .map((c) => ({ id: c.id, fact: c.fact, sim: cosine(vec, parseEmb(c.embedding)) }))
    .filter((c) => c.sim >= GRAY_FLOOR)
    .sort((a, b) => b.sim - a.sim);

  // Clear duplicate → merge outright (refresh to the newest wording), no judgment needed.
  if (candidates[0] && candidates[0].sim >= DEDUP_THRESHOLD) return mergeInto(candidates[0].id);

  // Gray band: let the judge (if any) decide same-vs-distinct, top-down.
  if (opts.judge) {
    for (const c of candidates) {
      if (await opts.judge(c.fact, input.fact)) return mergeInto(c.id);
    }
  }

  const info = db
    .prepare(
      `INSERT INTO facts (fact, embedding, scope, asserted_by, source_surface, confidence, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(input.fact, JSON.stringify(vec), scope, input.id.speaker, input.id.surface, 1.0, ts, ts);
  return { action: 'inserted', id: Number(info.lastInsertRowid) };
}

/** Live facts in the scopes this identity may recall from (company + bot-wide + 1:1-if-DM). */
function liveFacts(id: Identity): Row[] {
  const scopes = recallScopes(id);
  if (scopes.length === 0) return [];
  const placeholders = scopes.map(() => '?').join(',');
  return getDb()
    .prepare(`SELECT * FROM facts WHERE scope IN (${placeholders}) AND deleted_at IS NULL`)
    .all(...scopes) as Row[];
}

/** Semantic recall over the tiers this bot can access, ranked by cosine. */
export async function recall(query: string, id: Identity, limit = 5): Promise<StoredFact[]> {
  const rows = liveFacts(id);
  if (rows.length === 0) return [];
  const qv = await embed(query);
  return rows
    .map((r) => ({ r, sim: cosine(qv, parseEmb(r.embedding)) }))
    .sort((a, b) => b.sim - a.sim)
    .slice(0, limit)
    .map(({ r }) => stripEmb(r));
}

/** Nearest accessible fact to a query — used by update/forget to target a fact by meaning. */
async function nearest(query: string, id: Identity): Promise<{ row: Row; sim: number } | undefined> {
  const rows = liveFacts(id);
  if (rows.length === 0) return undefined;
  const qv = await embed(query);
  let best: { row: Row; sim: number } | undefined;
  for (const r of rows) {
    const sim = cosine(qv, parseEmb(r.embedding));
    if (!best || sim > best.sim) best = { row: r, sim };
  }
  return best;
}

/** Overwrite the fact nearest to `query` with `newFact`. Returns the updated fact, or null. */
export async function updateFact(
  query: string,
  newFact: string,
  id: Identity,
): Promise<StoredFact | null> {
  const hit = await nearest(query, id);
  if (!hit) return null;
  const vec = await embed(newFact);
  const ts = nowIso();
  getDb()
    .prepare(`UPDATE facts SET fact = ?, embedding = ?, updated_at = ? WHERE id = ?`)
    .run(newFact, JSON.stringify(vec), ts, hit.row.id);
  return { ...stripEmb(hit.row), fact: newFact, updated_at: ts };
}

/** Soft-delete (tombstone) the fact nearest to `query` — never a hard delete. Returns it, or null. */
export async function forgetFact(query: string, id: Identity): Promise<StoredFact | null> {
  const hit = await nearest(query, id);
  if (!hit) return null;
  getDb().prepare(`UPDATE facts SET deleted_at = ? WHERE id = ?`).run(nowIso(), hit.row.id);
  return stripEmb(hit.row);
}
