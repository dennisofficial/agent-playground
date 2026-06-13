import { toSql } from 'pgvector';
import { Fact } from '@workspace/shared/schemas';
import { In, Repository } from 'typeorm';
import { EmbeddingProvider } from './embedding';
import {
  Identity,
  projectLabel,
  projectScope,
  recallProjects,
  recallScopes,
  scopeForTier,
  teamScope,
  Tier,
} from '../domain/identity';

/**
 * Self-managed semantic memory over distilled facts, stored at one of the sharing tiers (see identity.ts).
 * Ported from playground/src/memory/semantic.ts: same thresholds + dedup + recency-tiebreak, but the JS
 * cosine-over-JSON is replaced by pgvector `embedding <=> :qv` (HNSW-indexed). Framework-light — takes a
 * TypeORM `Repository<Fact>` + an `EmbeddingProvider`, so it's unit/integration-testable without Nest.
 *
 * All vector reads use `createQueryBuilder` with named parameters and `getRawAndEntities()` for
 * type-safe entity hydration. The `embedding <=>` operator is a raw SQL fragment (pgvector provides no
 * typed QB helpers), but named params and TypeORM-managed soft-delete + timestamps replace the previous
 * positional `$1..$N` strings. Writes use QB insert/update + `pgvector.toSql` for the vector literal.
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
  /** For a 'project'-tier write from a DM: which project the fact belongs to. Must be one the
   * pair shares (see `scopeForTier`) — un-named/unknown falls back to the pair scope. */
  project?: string;
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

// Fraction of a recall's slots RESERVED for pure relevance (recency cannot evict them). The bug this
// fixes: with a single sim+recency score, a tiny recency bonus flips a fresh-but-weaker fact above an
// older-but-more-relevant one, so a saved fact that directly answers the query never surfaces. By
// filling the first ceil(limit * RELEVANCE_RESERVE) slots strictly by cosine, the most-relevant facts
// are guaranteed in regardless of age; the remaining slots stay recency-blended so freshness still
// tiebreaks among comparably-relevant facts. Threshold-free on purpose — a hard "strong match" cosine
// cutoff is unstable across embedding models, but reserving slots is not.
const RELEVANCE_RESERVE = 0.5;

/** Serialize a JS vector to the pgvector SQL literal (e.g. `[0.1,0.2,…]`). Non-null assertion is safe
 * because we always pass a non-null number[] produced by the embedder. */
const vecSql = (v: number[]): string => toSql(v)!;

/** Map a hydrated Fact entity to the DTO exposed by the public API. */
function factToStored(f: Fact): StoredFact {
  return {
    id: f.id,
    fact: f.fact,
    scope: f.scope,
    asserted_by: f.asserted_by,
    source_surface: f.source_surface,
    confidence: f.confidence,
    created_at: f.created_at.toISOString(),
    updated_at: f.updated_at.toISOString(),
  };
}

export class SemanticMemory {
  constructor(
    private readonly facts: Repository<Fact>,
    private readonly embedder: EmbeddingProvider,
  ) {}

  /** Embed text to the pgvector SQL literal the queries use — exposed so a caller running BOTH recall
   * paths over the same query (the fetch pass) embeds once and reuses the vector. */
  async embed(text: string): Promise<string> {
    return vecSql(await this.embedder.embed(text));
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
    const qv = vecSql(await this.embedder.embed(input.fact));
    const scope = scopeForTier(input.tier, input.id, input.project);

    // Dedup-candidate search: facts in the same scope/team that are similar enough to merge.
    // @DeleteDateColumn auto-adds deleted_at IS NULL. Note: strict team_id equality (no IS NULL) —
    // we never merge a tenant fact into the global/shared tier.
    const { entities: cands, raw: cRaw } = await this.facts
      .createQueryBuilder('f')
      .addSelect('1 - (f.embedding <=> :qv::vector)', 'sim')
      .where('f.scope = :scope', { scope })
      .andWhere('f.team_id = :team', { team: input.id.team })
      .andWhere('1 - (f.embedding <=> :qv::vector) >= :floor', {
        floor: GRAY_FLOOR,
      })
      .orderBy('f.embedding <=> :qv::vector', 'ASC')
      .setParameter('qv', qv)
      // entities[i] and raw[i] are aligned only because this is a single-table query —
      // adding a JOIN would silently misalign sim scores.
      .getRawAndEntities();

    const candidates = cands.map((e, i) => ({
      id: e.id,
      fact: e.fact,
      sim: Number(cRaw[i].sim),
    }));

    const top = candidates[0];
    if (top && top.sim >= DEDUP_THRESHOLD)
      return this.mergeInto(top.id, input.fact, qv);

    if (opts.judge) {
      for (const c of candidates) {
        if (await opts.judge(c.fact, input.fact))
          return this.mergeInto(c.id, input.fact, qv);
      }
    }

    // No dedup match — insert a new fact. `embedding: () => ':qv::vector'` is TypeORM's raw-SQL
    // value syntax; the :qv parameter is bound via setParameter below.
    const result = await this.facts
      .createQueryBuilder()
      .insert()
      .into(Fact)
      .values({
        fact: input.fact,
        embedding: () => ':qv::vector',
        scope,
        team_id: input.id.team,
        asserted_by: input.id.speaker,
        source_surface: input.id.surface,
        confidence: 1.0,
        embed_model: this.embedder.model,
      })
      .setParameter('qv', qv)
      .execute();

    return { action: 'inserted', id: result.identifiers[0].id as number };
  }

  private async mergeInto(
    id: number,
    fact: string,
    qv: string,
  ): Promise<{ action: 'updated'; id: number }> {
    // @UpdateDateColumn is auto-included by TypeORM's UpdateQueryBuilder.
    await this.facts
      .createQueryBuilder()
      .update(Fact)
      .set({
        fact,
        embedding: () => ':qv::vector',
        embed_model: this.embedder.model,
      })
      .where('id = :id', { id })
      .setParameter('qv', qv)
      .execute();
    return { action: 'updated', id };
  }

  /**
   * Semantic recall over the tiers this bot can access. Facts below `floor` cosine to the query are
   * dropped; the rest are ranked TWO-TIER (see `rankRecall`): the most-relevant facts are reserved a
   * slot so recency can't bury a strong match, and the remaining slots are recency-blended. The FETCH
   * path uses the default floor; the RECONCILE path passes a lower one (it wants marginal neighbors to
   * detect supersession).
   */
  async recall(
    query: string,
    id: Identity,
    limit = 5,
    floor = MIN_RECALL_SIM,
    precomputed?: string,
  ): Promise<StoredFact[]> {
    const scopes = recallScopes(id);
    if (scopes.length === 0) return [];
    const qv = precomputed ?? (await this.embed(query));

    const { entities, raw } = await this.facts
      .createQueryBuilder('f')
      .addSelect('1 - (f.embedding <=> :qv::vector)', 'sim')
      .where('f.scope = ANY(:scopes)', { scopes })
      .andWhere('(f.team_id = :team OR f.team_id IS NULL)', { team: id.team })
      .andWhere('1 - (f.embedding <=> :qv::vector) >= :floor', { floor })
      .orderBy('f.embedding <=> :qv::vector', 'ASC')
      .limit(limit + 20)
      .setParameter('qv', qv)
      // entities[i] and raw[i] are aligned only because this is a single-table query —
      // adding a JOIN would silently misalign sim scores.
      .getRawAndEntities();

    const pairs = entities.map((e, i) => ({
      entity: e,
      sim: Number(raw[i].sim),
    }));
    return this.rankRecall(pairs, limit).map(({ entity }) =>
      factToStored(entity),
    );
  }

  /**
   * Read-only cross-project recall: strongly-relevant facts from OTHER projects, each tagged with its
   * project id. Deliberately separate from `recall` — never feeds write-targeting or dedup.
   */
  async recallOtherProjects(
    query: string,
    id: Identity,
    opts: { floor?: number; limit?: number; precomputed?: string } = {},
  ): Promise<OtherProjectFact[]> {
    const floor = opts.floor ?? OTHER_PROJECT_FLOOR;
    const limit = opts.limit ?? 3;
    // "Other" = not recallable this turn — a DM already recalls every shared project directly, so
    // those must not double-surface here as labeled cross-project rows.
    const self = recallProjects(id).map(projectScope);
    const qv = opts.precomputed ?? (await this.embed(query));

    const { entities, raw } = await this.facts
      .createQueryBuilder('f')
      .addSelect('1 - (f.embedding <=> :qv::vector)', 'sim')
      .where("f.scope LIKE 'project:%'")
      .andWhere('f.scope <> ALL(:self::text[])', { self })
      .andWhere('(f.team_id = :team OR f.team_id IS NULL)', { team: id.team })
      .andWhere('1 - (f.embedding <=> :qv::vector) >= :floor', { floor })
      .orderBy('f.embedding <=> :qv::vector', 'ASC')
      .limit(limit + 20)
      .setParameter('qv', qv)
      // entities[i] and raw[i] are aligned only because this is a single-table query —
      // adding a JOIN would silently misalign sim scores.
      .getRawAndEntities();

    const pairs = entities.map((e, i) => ({
      entity: e,
      sim: Number(raw[i].sim),
    }));
    return this.rankRecall(pairs, limit).map(({ entity, sim }) => ({
      fact: factToStored(entity),
      sim,
      project: projectLabel(entity.scope) ?? entity.scope,
    }));
  }

  /**
   * Re-rank a distance-ordered window into the top `limit`, two-tier:
   *   1. RELEVANCE tier — the first `ceil(limit * RELEVANCE_RESERVE)` slots go to the highest-cosine
   *      facts (recency only breaks exact ties). This guarantees a strong match surfaces no matter how
   *      old it is — the fix for fresh-but-weaker facts evicting the fact that actually answers the query.
   *   2. RECENCY-BLENDED tier — the remaining slots fill from what's left by (cosine + recency tiebreak),
   *      so freshness still wins among comparably-relevant facts.
   * The merged result is returned strongest-relevance-first (the injected recall block reads top-down,
   * so the most relevant fact lands at the head rather than buried in the middle).
   */
  private rankRecall(
    pairs: { entity: Fact; sim: number }[],
    limit: number,
  ): { entity: Fact; sim: number }[] {
    if (pairs.length <= limit) {
      return [...pairs].sort((a, b) => b.sim - a.sim);
    }
    const scored = pairs.map((p) => ({
      ...p,
      recency: recencyBonus(p.entity.updated_at.toISOString()),
    }));
    const reserve = Math.min(
      limit,
      Math.max(1, Math.ceil(limit * RELEVANCE_RESERVE)),
    );

    const byRelevance = [...scored].sort(
      (a, b) => b.sim - a.sim || b.recency - a.recency,
    );
    const tierA = byRelevance.slice(0, reserve);
    const taken = new Set(tierA.map((x) => x.entity.id));

    const tierB = scored
      .filter((x) => !taken.has(x.entity.id))
      .sort((a, b) => b.sim + b.recency - (a.sim + a.recency))
      .slice(0, limit - tierA.length);

    return [...tierA, ...tierB]
      .sort((a, b) => b.sim - a.sim)
      .map(({ entity, sim }) => ({ entity, sim }));
  }

  /**
   * A cheap, always-on standing-preferences core: the top `limit` team-scope facts for this team,
   * ordered by recency then confidence — **no embedding** (must be near-free; runs on every turn).
   * Used by the context assembler to build the tiny injected standing-context block; never for
   * dedup or similarity judgments. Returns a newline-joined list of `- fact` lines, or '' when
   * the team scope holds no live facts.
   */
  async standingContext(id: Identity, limit = 5): Promise<string> {
    const scope = teamScope(id.team);
    const rows = await this.facts
      .createQueryBuilder('f')
      .where('f.scope = :scope', { scope })
      .andWhere('f.team_id = :team', { team: id.team })
      .orderBy('f.updated_at', 'DESC')
      .addOrderBy('f.confidence', 'DESC')
      .limit(limit)
      .getMany();
    if (rows.length === 0) return '';
    return rows.map((f) => `- ${f.fact}`).join('\n');
  }

  /** A live fact by row id, ONLY if in a scope this identity may access — the id-op guard. */
  private async liveFactById(
    rowId: number,
    id: Identity,
  ): Promise<Fact | undefined> {
    const scopes = recallScopes(id);
    if (scopes.length === 0) return undefined;
    return (
      (await this.facts
        .createQueryBuilder('f')
        .where('f.id = :rowId', { rowId })
        .andWhere('f.scope = ANY(:scopes)', { scopes })
        .andWhere('(f.team_id = :team OR f.team_id IS NULL)', { team: id.team })
        .getOne()) ?? undefined
    );
  }

  /** Overwrite a fact by row id (scope-checked). Returns the updated fact, or null. */
  async updateFactById(
    rowId: number,
    newFact: string,
    id: Identity,
  ): Promise<StoredFact | null> {
    const row = await this.liveFactById(rowId, id);
    if (!row) return null;
    const qv = vecSql(await this.embedder.embed(newFact));
    await this.facts
      .createQueryBuilder()
      .update(Fact)
      .set({
        fact: newFact,
        embedding: () => ':qv::vector',
        embed_model: this.embedder.model,
      })
      .where('id = :rowId', { rowId })
      .setParameter('qv', qv)
      .execute();
    // Two round trips (update then re-fetch) rather than a single UPDATE…RETURNING; not atomic,
    // but acceptable for this use case.
    const updated = await this.facts.findOne({ where: { id: rowId } });
    return updated ? factToStored(updated) : null;
  }

  /** Soft-delete a fact by row id (scope-checked). Returns it, or null. */
  async forgetFactById(
    rowId: number,
    id: Identity,
  ): Promise<StoredFact | null> {
    const row = await this.liveFactById(rowId, id);
    if (!row) return null;
    await this.facts.softDelete(rowId);
    return factToStored(row);
  }

  // ── Scope-level methods for trusted infrastructure (cron jobs) ─────────────
  // These bypass the conversation-Identity guard — callers are responsible for
  // enforcing (scope, team_id) isolation and running inside CredentialContext.

  /**
   * All live facts in a given (scope, teamId), ordered newest-first. For the consolidation job:
   * only facts the job may reason over — no cross-scope leakage. Capped at `limit`.
   */
  async listLiveByScope(
    scope: string,
    teamId: string,
    limit = 200,
  ): Promise<Fact[]> {
    return this.facts
      .createQueryBuilder('f')
      .where('f.scope = :scope', { scope })
      .andWhere('f.team_id = :teamId', { teamId })
      .orderBy('f.updated_at', 'DESC')
      .limit(limit)
      .getMany();
  }

  /**
   * Collapse duplicate facts into one canonical statement. The survivor's text and embedding are
   * updated; the dropped facts are soft-deleted. Caller is responsible for serializing via
   * `MemoryWriteService.withLock` — this method performs no locking of its own.
   *
   * Safety: all operations are constrained to `teamId` so a bug in the consolidation loop can't
   * touch another tenant's data.
   */
  async mergeFacts(
    survivorId: number,
    droppedIds: number[],
    canonicalText: string,
    teamId: string,
  ): Promise<void> {
    if (droppedIds.length === 0) return;
    const qv = vecSql(await this.embedder.embed(canonicalText));
    await this.facts
      .createQueryBuilder()
      .update(Fact)
      .set({
        fact: canonicalText,
        embedding: () => ':qv::vector',
        embed_model: this.embedder.model,
      })
      .where('id = :survivorId AND team_id = :teamId', { survivorId, teamId })
      .setParameter('qv', qv)
      .execute();
    await this.facts.softDelete({ id: In(droppedIds), team_id: teamId });
  }

  /**
   * Soft-delete a fact by id, enforcing (scope, teamId) so a stray drop can't touch
   * a different scope or tenant. For the consolidation job's drop-stale path.
   */
  async forgetByIdInScope(
    id: number,
    scope: string,
    teamId: string,
  ): Promise<void> {
    await this.facts.softDelete({ id, scope, team_id: teamId });
  }
}
