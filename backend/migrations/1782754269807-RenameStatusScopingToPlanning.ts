import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Rename the thread status value `scoping` → `planning`. `threads.status` is a plain `text` column
 * (no Postgres enum type), so this is a pure data backfill — there is no type to ALTER and no schema
 * diff for the generator to emit, hence the hand-authored migration. Keep this in lockstep with the
 * `ThreadStatus` union in `domain/thread.ts` (the canonical "enum").
 */
export class RenameStatusScopingToPlanning1782754269807 implements MigrationInterface {
  name = 'RenameStatusScopingToPlanning1782754269807';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `UPDATE "threads" SET "status" = 'planning' WHERE "status" = 'scoping'`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `UPDATE "threads" SET "status" = 'scoping' WHERE "status" = 'planning'`,
    );
  }
}
