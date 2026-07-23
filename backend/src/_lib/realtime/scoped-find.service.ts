import { Injectable } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { getExposed } from '@workspace/nestjs-rls';
import { Db } from '@workspace/nestjs-rls/nest';
import { toFindOptionsWhere } from '@workspace/nestjs-rls/typeorm';
import type { Row } from '@workspace/pg-realtime';
import { getRealtimePublish } from '@workspace/pg-realtime/nest-realtime';
import type { QuerySpec } from '@workspace/pg-realtime/socketio';
import type { DataSource, EntityMetadata, FindOptionsOrder, FindOptionsWhere } from 'typeorm';

/** An entity class constructor — typed narrower than `Function` per house lint rules. */
type EntityClass = new (...args: unknown[]) => object;

@Injectable()
export class ScopedFindService {
  private entityByModel: Map<string, EntityClass> | null = null;

  constructor(
    @InjectDataSource() private readonly dataSource: DataSource,
    private readonly db: Db,
  ) {}

  async find(
    model: string,
    spec: QuerySpec,
    _principal: unknown,
  ): Promise<Array<{ pk: string; row: Row }>> {
    if (spec.after !== undefined) {
      throw new Error('scopedFind: keyset pagination (spec.after) not yet implemented');
    }

    const { entity, metadata } = this.resolveModel(model);
    const exposed = getExposed(entity);
    const reverseExposed = new Map(
      Array.from(exposed, ([property, outputName]) => [outputName, property]),
    );

    const where = spec.filter ? this.toWhere(spec.filter, reverseExposed, model) : undefined;
    const order = spec.sort ? this.toOrder(spec.sort, reverseExposed, model) : undefined;

    const rows = await this.db.scoped(entity).find({
      where,
      order,
      take: spec.limit,
      skip: spec.offset,
    });

    const pkProperties = metadata.primaryColumns.map((c) => c.propertyName);
    return rows.map((row) => ({
      pk: this.buildPk(pkProperties, row as Record<string, unknown>),
      row: this.project(row as Record<string, unknown>, exposed),
    }));
  }

  private resolveModel(model: string): { entity: EntityClass; metadata: EntityMetadata } {
    if (!this.entityByModel) {
      const byModel = new Map<string, EntityClass>();
      for (const metadata of this.dataSource.entityMetadatas) {
        if (typeof metadata.target !== 'function') continue;
        const publish = getRealtimePublish(metadata.target);
        if (!publish) continue;
        byModel.set(publish.name ?? metadata.tableName, metadata.target as EntityClass);
      }
      this.entityByModel = byModel;
    }

    const entity = this.entityByModel.get(model);
    if (!entity) throw new Error(`scopedFind: no @Realtime entity registered as "${model}"`);
    return { entity, metadata: this.dataSource.getMetadata(entity) };
  }

  private toWhere(
    filter: Record<string, unknown>,
    reverseExposed: Map<string, string>,
    model: string,
  ): FindOptionsWhere<unknown> | FindOptionsWhere<unknown>[] {
    return toFindOptionsWhere(this.remapFields(filter, reverseExposed, model));
  }

  /** Translate wire (`@Expose`d) field names back to entity property names, recursing through
   *  `$and`/`$or`; any other field not exposed on the entity throws rather than silently
   *  leaking/hiding rows. */
  private remapFields(
    filter: Record<string, unknown>,
    reverseExposed: Map<string, string>,
    model: string,
  ): Record<string, unknown> {
    const out: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(filter)) {
      if (key === '$and' || key === '$or') {
        out[key] = (value as Record<string, unknown>[]).map((branch) =>
          this.remapFields(branch, reverseExposed, model),
        );
        continue;
      }
      if (key.startsWith('$')) {
        throw new Error(`scopedFind: unsupported top-level operator "${key}" on "${model}"`);
      }
      const property = reverseExposed.get(key);
      if (!property) {
        throw new Error(
          `scopedFind: field "${key}" is not exposed on "${model}" — cannot filter by it`,
        );
      }
      out[property] = value;
    }
    return out;
  }

  private toOrder(
    sort: Array<[string, 'asc' | 'desc']>,
    reverseExposed: Map<string, string>,
    model: string,
  ): FindOptionsOrder<unknown> {
    const order: Record<string, 'ASC' | 'DESC'> = {};
    for (const [field, direction] of sort) {
      const property = reverseExposed.get(field);
      if (!property) {
        throw new Error(
          `scopedFind: field "${field}" is not exposed on "${model}" — cannot sort by it`,
        );
      }
      order[property] = direction === 'asc' ? 'ASC' : 'DESC';
    }
    return order;
  }

  private project(row: Record<string, unknown>, exposed: Map<string, string>): Row {
    const out: Row = {};
    for (const [property, outputName] of exposed) {
      out[outputName] = row[property];
    }
    return out;
  }

  private buildPk(pkProperties: string[], row: Record<string, unknown>): string {
    return JSON.stringify(pkProperties.map((p) => row[p] ?? null));
  }
}
