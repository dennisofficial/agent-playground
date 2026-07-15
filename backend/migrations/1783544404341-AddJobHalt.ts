import { MigrationInterface, QueryRunner } from 'typeorm';

export class AddJobHalt1783544404341 implements MigrationInterface {
  name = 'AddJobHalt1783544404341';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "jobs" ADD "halt" jsonb`);
    // Backfill legacy rows: the phase they halted in was never recorded, so use a best-effort phase.
    // A failed job is terminal/inactive → park it in the terminal `done` band with a failed halt mark.
    await queryRunner.query(`UPDATE "jobs" SET status = 'done',
            halt = jsonb_build_object('kind', 'failed', 'reason', '(migrated)', 'at', now()::text)
            WHERE status = 'failed'`);
    // A paused job is still actionable (awaiting a credential) → keep it in the active Building band.
    await queryRunner.query(`UPDATE "jobs" SET status = 'running',
            halt = jsonb_build_object('kind', 'blocked_credentials', 'reason', '(migrated)', 'at', now()::text)
            WHERE status = 'paused'`);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `UPDATE "jobs" SET status = 'failed' WHERE halt->>'kind' = 'failed'`,
    );
    await queryRunner.query(`UPDATE "jobs" SET status = 'paused'
            WHERE halt->>'kind' IN ('blocked_credentials', 'budget_exhausted', 'incomplete')`);
    await queryRunner.query(`ALTER TABLE "jobs" DROP COLUMN "halt"`);
  }
}
