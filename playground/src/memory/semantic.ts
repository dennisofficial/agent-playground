import { getDb } from './db.js';
import { cosine, embed } from './embeddings.js';
import {
  canSurface,
  defaultVisibility,
  type FactKind,
  type Identity,
  recallScopes,
  type Visibility,
} from './identity.js';

/**
 * Self-managed semantic memory — the `remember` / `recall` / `update` / `forget` surface from
 * ARCHITECTURE.md. This is the abstraction boundary: callers never see SQLite or cosine, so the
 * backend can become sqlite-vec or Hindsight later without touching them.
 */

export interface StoredFact {
  id: number;
  fact: string;
  subject_scope: string;
  visibility: Visibility;
  kind: FactKind;
  owner_agent: string;
  asserted_by: string | null;
  source_surface: string | null;
  confidence: number;
  created_at: string;
  updated_at: string;
}

type Row = StoredFact & { embedding: string };

// Cosine above this, within the same subject scope, means "the same fact" → update in place rather
// than storing a near-duplicate. This is what makes repeated "Dennis prefers TypeScript" converge.
const DEDUP_THRESHOLD = 0.92;

const nowIso = () => new Date().toISOString();
const parseEmb = (s: string): number[] => JSON.parse(s) as number[];
const stripEmb = ({ embedding: _embedding, ...rest }: Row): StoredFact => rest;

export interface RememberInput {
  fact: string;
  /** Who/what the fact is about, e.g. `person:dennis`, `company:local`. */
  subjectScope: string;
  visibility?: Visibility;
  kind?: FactKind;
  /** The active identity — provides owner_agent, asserted_by, source_surface. */
  id: Identity;
}

/** Store a fact, or update the nearest near-duplicate in the same subject scope (dedup-on-upsert). */
export async function remember(
  input: RememberInput,
): Promise<{ action: 'inserted' | 'updated'; id: number }> {
  const db = getDb();
  const vec = await embed(input.fact);
  const kind = input.kind ?? 'work';
  const visibility = input.visibility ?? defaultVisibility(kind);
  const ts = nowIso();

  const candidates = db
    .prepare(`SELECT id, embedding FROM facts WHERE subject_scope = ? AND deleted_at IS NULL`)
    .all(input.subjectScope) as { id: number; embedding: string }[];
  let best: { id: number; sim: number } | undefined;
  for (const c of candidates) {
    const sim = cosine(vec, parseEmb(c.embedding));
    if (!best || sim > best.sim) best = { id: c.id, sim };
  }

  if (best && best.sim >= DEDUP_THRESHOLD) {
    db.prepare(
      `UPDATE facts SET fact = ?, embedding = ?, visibility = ?, kind = ?, updated_at = ? WHERE id = ?`,
    ).run(input.fact, JSON.stringify(vec), visibility, kind, ts, best.id);
    return { action: 'updated', id: best.id };
  }

  const info = db
    .prepare(
      `INSERT INTO facts
         (fact, embedding, subject_scope, visibility, owner_agent, asserted_by, source_surface, kind, confidence, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      input.fact,
      JSON.stringify(vec),
      input.subjectScope,
      visibility,
      input.id.selfAgent,
      input.id.speaker,
      input.id.surface,
      kind,
      1.0,
      ts,
      ts,
    );
  return { action: 'inserted', id: Number(info.lastInsertRowid) };
}

/** Load the live, surfaceable facts in the current scopes (no embedding column). */
function liveFacts(id: Identity): Row[] {
  const scopes = recallScopes(id);
  if (scopes.length === 0) return [];
  const placeholders = scopes.map(() => '?').join(',');
  const rows = getDb()
    .prepare(`SELECT * FROM facts WHERE subject_scope IN (${placeholders}) AND deleted_at IS NULL`)
    .all(...scopes) as Row[];
  return rows.filter((r) => canSurface(r, id));
}

/** Semantic recall: facts whose subject is in scope AND whose visibility permits this surface, ranked by cosine. */
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

/** Find the single nearest surfaceable fact to a query (used by update/forget to target a fact by meaning). */
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

/** Overwrite the fact nearest to `query` with `newFact` (re-embedded). Returns the updated fact, or null. */
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

/** Soft-delete (tombstone) the fact nearest to `query` — never a hard delete, so human-asserted facts
 *  can be recovered/audited (D6). Returns the forgotten fact, or null. */
export async function forgetFact(query: string, id: Identity): Promise<StoredFact | null> {
  const hit = await nearest(query, id);
  if (!hit) return null;
  getDb().prepare(`UPDATE facts SET deleted_at = ? WHERE id = ?`).run(nowIso(), hit.row.id);
  return stripEmb(hit.row);
}
