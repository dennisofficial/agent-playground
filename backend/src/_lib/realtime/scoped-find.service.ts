import { Injectable } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { getExposed } from '@workspace/nestjs-rls';
import { Db } from '@workspace/nestjs-rls/nest';
import type { Row } from '@workspace/pg-realtime';
import { createWindowedScopedFind } from '@workspace/pg-realtime/nest-realtime';
import type { QuerySpec } from '@workspace/pg-realtime/socketio';
import type { DataSource, EntityTarget, FindManyOptions, ObjectLiteral } from 'typeorm';

/**
 * Thin app-side plug for `@workspace/pg-realtime`'s Mode B windowed-query engine: the actual
 * `WHERE`/`ORDER BY`/keyset-pagination/`@Expose` projection logic lives in
 * `createWindowedScopedFind` (package, cycle-free of `@workspace/nestjs-rls`) — this service
 * only wires up the RLS-scoped fetch (`db.scoped(entity).find(...)`) and `@Expose` map plugs.
 */
@Injectable()
export class ScopedFindService {
  private readonly scopedFind: (
    model: string,
    spec: QuerySpec,
    principal: unknown,
  ) => Promise<Array<{ pk: string; row: Row }>>;

  constructor(
    @InjectDataSource() dataSource: DataSource,
    private readonly db: Db,
  ) {
    this.scopedFind = createWindowedScopedFind({
      dataSource,
      resolveExposed: getExposed,
      runScopedFind: <E extends ObjectLiteral>(entity: EntityTarget<E>, findOptions: FindManyOptions<E>) =>
        this.db.scoped(entity).find(findOptions),
    });
  }

  find(model: string, spec: QuerySpec, principal: unknown): Promise<Array<{ pk: string; row: Row }>> {
    return this.scopedFind(model, spec, principal);
  }
}
