import { Fact } from '@workspace/shared/schemas';
import { Repository } from 'typeorm';
import { EmbeddingProvider, toPgVector } from './embedding';
import { rawRows, toIso } from './sql';
import {
  Identity,
  projectLabel,
  projectScope,
  recallScopes,
  scopeForTier,
  Tier,
} from '../domain/identity';

/**
 * Self-managed semantic memory over distilled facts, stored at one of the sharing tiers (see identity.ts).
 * Ported from playground/src/memory/semantic.ts: same thresholds + dedup + recency-tiebreak, but the JS
 * cosine-over-JSON is replaced by pgvector `embedding <=> :q` (HNSW-indexed). Framework-light — takes a
 * TypeORM `Repository<Fact>` + an `EmbeddingProvider`, so it's unit/integration-testable without Nest.
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

export interface OtherProjectFact {
  fact: StoredFact;
  sim: number;
  project: string;
}

export interface RememberInput {
  fact: string;
  tier: Tier;
  id: Identity;
}

export interface RememberOpts {
  /** Gray-zone tiebreaker (existing, candidate) → same underlying fact? Injected (the LLM lives elsewhere). */
  judge?: (existing: string, candidate: string) => Promise<boolean>;
}

// Cosine ≥ this in the same scope = "the same fact" → merge, not a duplicate.
export const DEDUP_THRESHOLD = 0.92;
// Below the auto-merge bar but a likely paraphrase → sent to the judge (when supplied). Below this = new.
export const GRAY_FLOOR = 0.82;
// Recall floor: facts below this cosine to the query are not relevant enough to inject.
export const MIN_RECALL_SIM = 0.3;
// Cross-project recall floor (stricter than in-project).
export const OTHER_PROJECT_FLOOR = 0.45;

// Tiny recency tiebreak added to cosine for RANKING only (never the floors). Half-life in days.
const RECENCY_TIEBREAK = 0.03;
const RECENCY_HALFLIFE_DAYS = 30;
function recencyBonus(updatedAt: string): number {
  const ageMs = Date.now() - Date.parse(updatedAt);
  if (!Number.isFinite(ageMs) || ageMs < 0) return RECENCY_TIEBREAK;
  return RECENCY_TIEBREAK * 0.5 ** (ageMs / 86_400_000 / RECENCY_HALFLIFE_DAYS);
}

interface RawFactRow {
  id: number | string;
  fact: string;
  scope: string;
  asserted_by: string | null;
  source_surface: string | null;
  confidence: number | string;
  created_at: unknown;
  updated_at: unknown;
  sim?: number | string;
}

function toStoredFact(r: RawFactRow): StoredFact {
  return {
    id: Number(r.id),
    fact: r.fact,
    scope: r.scope,
    asserted_by: r.asserted_by,
    source_surface: r.source_surface,
    confidence: Number(r.confidence),
    created_at: toIso(r.created_at),
    updated_at: toIso(r.updated_at),
  };
}

const SELECT_COLS = `id, fact, scope, asserted_by, source_surface, confidence, created_at, updated_at`;

export class SemanticMemory {
  constructor(
    private readonly facts: Repository<Fact>,
    private readonly embedder: EmbeddingProvider,
  ) {}

  private async query<T = RawFactRow>(sql: string, params: unknown[]): Promise<T[]> {
    return rawRows<T>(await this.facts.manager.query(sql, params));
  }

  /**
   * Store a fact at its tier's scope, or merge into an existing near-duplicate in that scope. A candidate
   * at cosine ≥ DEDUP_THRESHOLD merges outright; one in [GRAY_FLOOR, DEDUP_THRESHOLD) merges only if the
   * injected `judge` confirms it (candidates walked most-similar-first).
   */
  async remember(
    input: RememberInput,
    opts: RememberOpts = {},
  ): Promise<{ action: 'inserted' | 'updated'; id: number }> {
    const qv = toPgVector(await this.embedder.embed(input.fact));
    const scope = scopeForTier(input.tier, input.id);

    const candidates = await this.query<{ id: number | string; fact: string; sim: number | string }>(
      `SELECT id, fact, 1 - (embedding <=> $1::vector) AS sim
       FROM facts
       WHERE scope = $2 AND deleted_at IS NULL AND 1 - (embedding <=> $1::vector) >= $3
       ORDER BY embedding <=> $1::vector ASC`,
      [qv, scope, GRAY_FLOOR],
    );

    const top = candidates[0];
    if (top && Number(top.sim) >= DEDUP_THRESHOLD) return this.mergeInto(Number(top.id), input.fact, qv);

    if (opts.judge) {
      for (const c of candidates) {
        if (await opts.judge(c.fact, input.fact)) return this.mergeInto(Number(c.id), input.fact, qv);
      }
    }

    const inserted = await this.query<{ id: number | string }>(
      `INSERT INTO facts (fact, embedding, scope, asserted_by, source_surface, confidence, embed_model, created_at, updated_at)
       VALUES ($1, $2::vector, $3, $4, $5, $6, $7, now(), now())
       RETURNING id`,
      [input.fact, qv, scope, input.id.speaker, input.id.surface, 1.0, this.embedder.model],
    );
    return { action: 'inserted', id: Number(inserted[0].id) };
  }

  private async mergeInto(
    id: number,
    fact: string,
    qv: string,
  ): Promise<{ action: 'updated'; id: number }> {
    await this.query(
      `UPDATE facts SET fact = $1, embedding = $2::vector, embed_model = $3, updated_at = now() WHERE id = $4`,
      [fact, qv, this.embedder.model, id],
    );
    return { action: 'updated', id };
  }

  /**
   * Semantic recall over the tiers this bot can access. Facts below `floor` cosine to the query are
   * dropped; the rest rank by cosine + a tiny recency tiebreak. The FETCH path uses the default floor;
   * the RECONCILE path passes a lower one (it wants marginal neighbors to detect supersession).
   */
  async recall(
    query: string,
    id: Identity,
    limit = 5,
    floor = MIN_RECALL_SIM,
  ): Promise<StoredFact[]> {
    const scopes = recallScopes(id);
    if (scopes.length === 0) return [];
    const qv = toPgVector(await this.embedder.embed(query));
    const rows = await this.query(
      `SELECT ${SELECT_COLS}, 1 - (embedding <=> $1::vector) AS sim
       FROM facts
       WHERE scope = ANY($2) AND deleted_at IS NULL AND 1 - (embedding <=> $1::vector) >= $3
       ORDER BY embedding <=> $1::vector ASC
       LIMIT $4`,
      [qv, scopes, floor, limit + 20],
    );
    return this.rankByRecency(rows, limit).map(toStoredFact);
  }

  /**
   * Read-only cross-project recall: strongly-relevant facts from OTHER projects, each tagged with its
   * project id. Deliberately separate from `recall` — never feeds write-targeting or dedup.
   */
  async recallOtherProjects(
    query: string,
    id: Identity,
    opts: { floor?: number; limit?: number } = {},
  ): Promise<OtherProjectFact[]> {
    const floor = opts.floor ?? OTHER_PROJECT_FLOOR;
    const limit = opts.limit ?? 3;
    const self = projectScope(id.project);
    const qv = toPgVector(await this.embedder.embed(query));
    const rows = await this.query(
      `SELECT ${SELECT_COLS}, 1 - (embedding <=> $1::vector) AS sim
       FROM facts
       WHERE scope LIKE 'project:%' AND scope != $2 AND deleted_at IS NULL
         AND 1 - (embedding <=> $1::vector) >= $3
       ORDER BY embedding <=> $1::vector ASC
       LIMIT $4`,
      [qv, self, floor, limit + 20],
    );
    return this.rankByRecency(rows, limit).map((r) => ({
      fact: toStoredFact(r),
      sim: Number(r.sim),
      project: projectLabel(r.scope) ?? r.scope,
    }));
  }

  /** Re-rank a distance-ordered window by (cosine + recency tiebreak) and take `limit`. */
  private rankByRecency(rows: RawFactRow[], limit: number): RawFactRow[] {
    return rows
      .map((r) => ({ r, score: Number(r.sim) + recencyBonus(toIso(r.updated_at)) }))
      .sort((a, b) => b.score - a.score)
      .slice(0, limit)
      .map(({ r }) => r);
  }

  /** A live fact by row id, ONLY if in a scope this identity may access — the id-op guard. */
  private async liveFactById(rowId: number, id: Identity): Promise<RawFactRow | undefined> {
    const scopes = recallScopes(id);
    if (scopes.length === 0) return undefined;
    const rows = await this.query(
      `SELECT ${SELECT_COLS} FROM facts WHERE id = $1 AND deleted_at IS NULL AND scope = ANY($2)`,
      [rowId, scopes],
    );
    return rows[0];
  }

  /** Overwrite a fact by row id (scope-checked). Returns the updated fact, or null. */
  async updateFactById(rowId: number, newFact: string, id: Identity): Promise<StoredFact | null> {
    const row = await this.liveFactById(rowId, id);
    if (!row) return null;
    const qv = toPgVector(await this.embedder.embed(newFact));
    const updated = await this.query(
      `UPDATE facts SET fact = $1, embedding = $2::vector, embed_model = $3, updated_at = now()
       WHERE id = $4 RETURNING ${SELECT_COLS}`,
      [newFact, qv, this.embedder.model, rowId],
    );
    return toStoredFact(updated[0]);
  }

  /** Soft-delete a fact by row id (scope-checked). Returns it, or null. */
  async forgetFactById(rowId: number, id: Identity): Promise<StoredFact | null> {
    const row = await this.liveFactById(rowId, id);
    if (!row) return null;
    await this.query(`UPDATE facts SET deleted_at = now() WHERE id = $1`, [rowId]);
    return toStoredFact(row);
  }
}
