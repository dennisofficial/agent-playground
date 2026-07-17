import { Inject, Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { toSql } from 'pgvector';
import { Repository } from 'typeorm';
import { DB_CONNECTION } from '../persistence/database.module';
import { MemoryEntity } from '../persistence/entities';
import { EMBEDDING_PROVIDER, type EmbeddingProvider } from './embedding';


export interface StoredFact {
  id: string;
  fact: string;
  scope: string;
  org_id: string;
  confidence: number;
  created_at: string;
  updated_at: string;
}

export interface RecalledFact extends StoredFact {
  sim: number;
}

export const DEDUP_THRESHOLD = 0.92;
export const MIN_RECALL_SIM = 0.3;

const vecSql = (v: number[]): string => toSql(v)!;

function toStored(f: MemoryEntity): StoredFact {
  return {
    id: f.id,
    fact: f.fact,
    scope: f.scope,
    org_id: f.org_id,
    confidence: f.confidence,
    created_at: f.created_at.toISOString(),
    updated_at: f.updated_at.toISOString(),
  };
}

export interface RememberInput {
  fact: string;
  scope: string;
  orgId: string;
  assertedBy?: string;
}

@Injectable()
export class MemoryStore {
  constructor(
    @InjectRepository(MemoryEntity, DB_CONNECTION)
    private readonly facts: Repository<MemoryEntity>,
    @Inject(EMBEDDING_PROVIDER)
    private readonly embedder: EmbeddingProvider,
  ) {}

  async embed(text: string, orgId?: string): Promise<string> {
    return vecSql(await this.embedder.embed(text, orgId));
  }

  async remember(input: RememberInput): Promise<{ action: 'inserted' | 'updated'; id: string }> {
    const qv = vecSql(await this.embedder.embed(input.fact, input.orgId));

    const qb = this.facts
      .createQueryBuilder('f')
      .addSelect('1 - (f.embedding <=> :qv::vector)', 'sim')
      .where('f.scope = :scope', { scope: input.scope })
      .andWhere('f.org_id = :team', { team: input.orgId })
      .andWhere('1 - (f.embedding <=> :qv::vector) >= :floor', {
        floor: DEDUP_THRESHOLD,
      })
      .orderBy('f.embedding <=> :qv::vector', 'ASC')
      .setParameter('qv', qv)
      .limit(1);
    const { entities } = await qb.getRawAndEntities();
    const dup = entities[0];
    if (dup) {
      await this.facts
        .createQueryBuilder()
        .update(MemoryEntity)
        .set({
          fact: input.fact,
          embedding: () => ':qv::vector',
          embed_model: this.embedder.model,
        })
        .where('id = :id', { id: dup.id })
        .setParameter('qv', qv)
        .execute();
      return { action: 'updated', id: dup.id };
    }

    const result = await this.facts
      .createQueryBuilder()
      .insert()
      .into(MemoryEntity)
      .values({
        fact: input.fact,
        embedding: () => ':qv::vector',
        scope: input.scope,
        org_id: input.orgId,
        asserted_by: input.assertedBy ?? null,
        confidence: 1.0,
        embed_model: this.embedder.model,
      })
      .setParameter('qv', qv)
      .execute();
    return { action: 'inserted', id: result.identifiers[0].id as string };
  }

  async recall(
    query: string,
    opts: { scopes: string[]; orgId: string; limit?: number; floor?: number },
  ): Promise<RecalledFact[]> {
    if (opts.scopes.length === 0) return [];
    const limit = opts.limit ?? 5;
    const floor = opts.floor ?? MIN_RECALL_SIM;
    const qv = await this.embed(query, opts.orgId);

    const { entities, raw } = await this.facts
      .createQueryBuilder('f')
      .addSelect('1 - (f.embedding <=> :qv::vector)', 'sim')
      .where('f.scope = ANY(:scopes)', { scopes: opts.scopes })
      .andWhere('f.org_id = :team', { team: opts.orgId })
      .andWhere('1 - (f.embedding <=> :qv::vector) >= :floor', { floor })
      .orderBy('f.embedding <=> :qv::vector', 'ASC')
      .limit(limit)
      .setParameter('qv', qv)
      .getRawAndEntities();

    return entities.map((e, i) => ({
      ...toStored(e),
      sim: Number(raw[i].sim),
    }));
  }

  async forget(id: string, orgId: string): Promise<{ deleted: boolean }> {
    const res = await this.facts
      .createQueryBuilder()
      .softDelete()
      .where('id = :id', { id })
      .andWhere('org_id = :org', { org: orgId })
      .andWhere('deleted_at IS NULL')
      .execute();
    return { deleted: (res.affected ?? 0) > 0 };
  }

  async updateFact(id: string, fact: string, orgId: string): Promise<{ updated: boolean }> {
    const existing = await this.facts
      .createQueryBuilder('f')
      .select('f.id', 'id')
      .where('f.id = :id', { id })
      .andWhere('f.org_id = :org', { org: orgId })
      .andWhere('f.deleted_at IS NULL')
      .getRawOne<{ id: string }>();
    if (!existing) return { updated: false };

    const qv = vecSql(await this.embedder.embed(fact, orgId));
    const res = await this.facts
      .createQueryBuilder()
      .update(MemoryEntity)
      .set({
        fact,
        embedding: () => ':qv::vector',
        embed_model: this.embedder.model,
      })
      .where('id = :id', { id })
      .andWhere('org_id = :org', { org: orgId })
      .andWhere('deleted_at IS NULL')
      .setParameter('qv', qv)
      .execute();
    return { updated: (res.affected ?? 0) > 0 };
  }
}
