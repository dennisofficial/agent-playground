import { MigrationInterface, QueryRunner } from 'typeorm';
import { DENSE_TASK_ORDINALS_UP } from '../src/app_old/persistence/dense-task-ordinals.sql';

/**
 * Backfill: renumber existing `tasks.ordinal` to a DENSE per-stage sequence (1, 2, 3…) so the short `#N`
 * task id the model + sidebar now surface starts at #1 for current tasks, instead of the old gap-numbering
 * (10, 20, 30) inherited from PR #261. `ordinal` doubles as the id post-#261 (the uuid PK stays the
 * internal row identity); this migration also remaps existing `blocked_by` arrays — which #261 stored in
 * uuid space (commit 08d0f45c) — onto the target rows' new `#N`, joining through the same per-stage
 * ROW_NUMBER mapping. Dangling uuid blockers (no matching row) are dropped.
 *
 * The backfill SQL lives in `src/app/persistence/dense-task-ordinals.sql.ts` so its live-Postgres
 * integration test runs the exact same statements. Data-only (no DDL): `down()` is a no-op — `ordinal` is
 * a valid display order whether dense or gap-numbered.
 */
export class DenseTaskOrdinals1784138169645 implements MigrationInterface {
  name = 'DenseTaskOrdinals1784138169645';

  public async up(queryRunner: QueryRunner): Promise<void> {
    for (const sql of DENSE_TASK_ORDINALS_UP) {
      await queryRunner.query(sql);
    }
  }

  public async down(): Promise<void> {
    // No-op: ordinal is a valid display/id order whether dense or gap-numbered.
  }
}
