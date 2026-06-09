import { getDb } from './db.js';
import { cosine, embed, EMBED_MODEL } from './embeddings.js';
import {
  type Identity,
  projectLabel,
  projectScope,
  recallScopes,
  scopeForTier,
  type Tier,
} from './identity.js';

/**
 * Self-managed semantic memory — `remember` / `recall` / `update` / `forget` over distilled facts,
 * stored at one of the sharing tiers (see identity.ts). The tier is the abstraction boundary; a
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

// Recall floor: facts below this cosine to the query are NOT relevant enough to inject — without it
// `recall` returns the "least irrelevant" facts on every turn (e.g. a thin "thanks" embeds to noise),
// polluting context. Tuned conservative; raise if junk still leaks, lower if real recall is missed.
export const MIN_RECALL_SIM = 0.3;
// Targeting floor for the query-based update/forget TOOLS: below this, there is no real match, so the
// op no-ops instead of clobbering the nearest unrelated fact. Higher than the recall floor — overwriting
// a fact demands a confident match. (The reconcile pass targets by id and bypasses this entirely.)
export const MIN_TARGET_SIM = 0.6;
// Cross-project recall floor: a fact from ANOTHER project crosses into the current turn only when it's
// at least this similar to the query. Calibrated against this file's own bars — MIN_RECALL_SIM 0.3
// ("relevant enough to inject" in-project), MIN_TARGET_SIM 0.6 ("confident same-topic match"), DEDUP 0.92
// ("near-duplicate"). We want "clearly on-point, not just relevant" — above the 0.3 inject floor so it's
// stricter for cross-project, but well below paraphrase territory (a cross-project parallel like "we hit
// this same auth issue on customer-panel" is RELATED, not a duplicate of the query). TUNE once running.
export const OTHER_PROJECT_FLOOR = 0.45;

// A small recency tiebreak added to the cosine for RANKING only (never for the floors): at equal
// similarity a freshly-written/reinforced fact outranks a stale one-off. Capped tiny so it reorders
// near-ties, never overrides a clearly-more-relevant fact. Half-life in days.
const RECENCY_TIEBREAK = 0.03;
const RECENCY_HALFLIFE_DAYS = 30;
const recencyBonus = (updatedAt: string): number => {
  const ageMs = Date.now() - Date.parse(updatedAt);
  if (!Number.isFinite(ageMs) || ageMs < 0) return RECENCY_TIEBREAK;
  return RECENCY_TIEBREAK * 0.5 ** (ageMs / 86_400_000 / RECENCY_HALFLIFE_DAYS);
};

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
    db.prepare(
      `UPDATE facts SET fact = ?, embedding = ?, embed_model = ?, updated_at = ? WHERE id = ?`,
    ).run(input.fact, JSON.stringify(vec), EMBED_MODEL, ts, id);
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
      `INSERT INTO facts (fact, embedding, scope, asserted_by, source_surface, confidence, embed_model, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      input.fact,
      JSON.stringify(vec),
      scope,
      input.id.speaker,
      input.id.surface,
      1.0,
      EMBED_MODEL,
      ts,
      ts,
    );
  return { action: 'inserted', id: Number(info.lastInsertRowid) };
}

/** Live facts in the scopes this identity may recall from (project + team + bot-wide + 1:1-if-DM). */
function liveFacts(id: Identity): Row[] {
  const scopes = recallScopes(id);
  if (scopes.length === 0) return [];
  const placeholders = scopes.map(() => '?').join(',');
  return getDb()
    .prepare(`SELECT * FROM facts WHERE scope IN (${placeholders}) AND deleted_at IS NULL`)
    .all(...scopes) as Row[];
}

/**
 * Semantic recall over the tiers this bot can access. Facts below `floor` cosine to the query are dropped
 * (relevance floor — no more injecting the "least irrelevant" facts on a thin turn); the rest rank by
 * cosine plus a tiny recency tiebreak (floor gates on raw similarity, ranking adds recency). The default
 * floor suits the FETCH path (suppress junk); the RECONCILE path passes a lower floor because it has the
 * opposite goal — it wants to SEE marginal neighbors so it can detect a fact this turn supersedes.
 */
export async function recall(
  query: string,
  id: Identity,
  limit = 5,
  floor = MIN_RECALL_SIM,
): Promise<StoredFact[]> {
  const rows = liveFacts(id);
  if (rows.length === 0) return [];
  const qv = await embed(query);
  return rows
    .map((r) => ({ r, sim: cosine(qv, parseEmb(r.embedding)) }))
    .filter((c) => c.sim >= floor)
    .sort((a, b) => b.sim + recencyBonus(b.r.updated_at) - (a.sim + recencyBonus(a.r.updated_at)))
    .slice(0, limit)
    .map(({ r }) => stripEmb(r));
}

/**
 * Read-only cross-project recall: the strongly-relevant facts from OTHER projects, each tagged with its
 * project id. `fetchContext` surfaces these LABELED ("[customer-panel] …") so a bot can reference another
 * project's decision without mistaking it for the current one. Deliberately SEPARATE from `recall` /
 * `recallScopes`: it never feeds write-targeting (update/forget) or dedup, so a bot on project B can
 * never edit or merge project A's facts. Filtered by a stricter floor + capped to a handful.
 */
export interface OtherProjectFact {
  fact: StoredFact;
  sim: number;
  project: string;
}

export async function recallOtherProjects(
  query: string,
  id: Identity,
  opts: { floor?: number; limit?: number } = {},
): Promise<OtherProjectFact[]> {
  const floor = opts.floor ?? OTHER_PROJECT_FLOOR;
  const limit = opts.limit ?? 3;
  const self = projectScope(id.project);
  const rows = getDb()
    .prepare(
      `SELECT * FROM facts WHERE scope LIKE 'project:%' AND scope != ? AND deleted_at IS NULL`,
    )
    .all(self) as Row[];
  if (rows.length === 0) return [];
  const qv = await embed(query);
  return rows
    .map((r) => ({ r, sim: cosine(qv, parseEmb(r.embedding)) }))
    .filter((c) => c.sim >= floor)
    .sort((a, b) => b.sim + recencyBonus(b.r.updated_at) - (a.sim + recencyBonus(a.r.updated_at)))
    .slice(0, limit)
    .map(({ r, sim }) => ({ fact: stripEmb(r), sim, project: projectLabel(r.scope) ?? r.scope }));
}

/**
 * Nearest accessible fact to a query — used by the query-based update/forget tools to target a fact by
 * meaning. Returns undefined when the best match is below `floor` (default `MIN_TARGET_SIM`): the data-
 * loss guard — without it, a target that doesn't really exist in the store overwrites/tombstones the
 * nearest unrelated fact. (The reconcile pass targets by id and never calls this.)
 */
async function nearest(
  query: string,
  id: Identity,
  floor = MIN_TARGET_SIM,
): Promise<{ row: Row; sim: number } | undefined> {
  const rows = liveFacts(id);
  if (rows.length === 0) return undefined;
  const qv = await embed(query);
  let best: { row: Row; sim: number } | undefined;
  for (const r of rows) {
    const sim = cosine(qv, parseEmb(r.embedding));
    if (!best || sim > best.sim) best = { row: r, sim };
  }
  return best && best.sim >= floor ? best : undefined;
}

/** Re-embed `newFact` and overwrite the given row in place; returns the new updated_at timestamp. */
async function writeFactUpdate(rowId: number, newFact: string): Promise<string> {
  const vec = await embed(newFact);
  const ts = nowIso();
  getDb()
    .prepare(
      `UPDATE facts SET fact = ?, embedding = ?, embed_model = ?, updated_at = ? WHERE id = ?`,
    )
    .run(newFact, JSON.stringify(vec), EMBED_MODEL, ts, rowId);
  return ts;
}

/** A live fact by row id, but ONLY if it sits in a scope this identity may access — the id-op guard. */
function liveFactById(rowId: number, id: Identity): Row | undefined {
  const scopes = recallScopes(id);
  if (scopes.length === 0) return undefined;
  const placeholders = scopes.map(() => '?').join(',');
  return getDb()
    .prepare(
      `SELECT * FROM facts WHERE id = ? AND deleted_at IS NULL AND scope IN (${placeholders})`,
    )
    .get(rowId, ...scopes) as Row | undefined;
}

/** Overwrite the fact nearest to `query` with `newFact` — no-ops when no match clears `MIN_TARGET_SIM`. */
export async function updateFact(
  query: string,
  newFact: string,
  id: Identity,
): Promise<StoredFact | null> {
  const hit = await nearest(query, id);
  if (!hit) return null;
  const ts = await writeFactUpdate(hit.row.id, newFact);
  return { ...stripEmb(hit.row), fact: newFact, updated_at: ts };
}

/** Soft-delete (tombstone) the fact nearest to `query` — never a hard delete. Returns it, or null. */
export async function forgetFact(query: string, id: Identity): Promise<StoredFact | null> {
  const hit = await nearest(query, id);
  if (!hit) return null;
  getDb().prepare(`UPDATE facts SET deleted_at = ? WHERE id = ?`).run(nowIso(), hit.row.id);
  return stripEmb(hit.row);
}

/**
 * Overwrite a fact by row id — the reconcile path's safe targeting. Scope-checked (the id must live in
 * one of this identity's recall scopes), so a hallucinated id can't reach across into another scope or
 * a tombstoned row. Returns the updated fact, or null when the id isn't accessible/live.
 */
export async function updateFactById(
  rowId: number,
  newFact: string,
  id: Identity,
): Promise<StoredFact | null> {
  const row = liveFactById(rowId, id);
  if (!row) return null;
  const ts = await writeFactUpdate(rowId, newFact);
  return { ...stripEmb(row), fact: newFact, updated_at: ts };
}

/** Soft-delete a fact by row id (scope-checked, like `updateFactById`). Returns it, or null. */
export function forgetFactById(rowId: number, id: Identity): StoredFact | null {
  const row = liveFactById(rowId, id);
  if (!row) return null;
  getDb().prepare(`UPDATE facts SET deleted_at = ? WHERE id = ?`).run(nowIso(), rowId);
  return stripEmb(row);
}
