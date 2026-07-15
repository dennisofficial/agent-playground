import { MigrationInterface, QueryRunner } from 'typeorm';

export class AddJobAutoApprove1783810998038 implements MigrationInterface {
  name = 'AddJobAutoApprove1783810998038';

  public async up(queryRunner: QueryRunner): Promise<void> {
    // Per-job auto-approve (see JobEntity.auto_approve / auto_approve_by). NOT NULL DEFAULT false
    // backfills existing rows safely. `auto_approve_by` is a plain FK column (no @ManyToOne relation),
    // so the FK constraint is hand-added here. Generator noise (unrelated index/constraint churn) pruned
    // per the migrations house rule.
    await queryRunner.query(
      `ALTER TABLE "jobs" ADD "auto_approve" boolean NOT NULL DEFAULT false`,
    );
    await queryRunner.query(`ALTER TABLE "jobs" ADD "auto_approve_by" uuid`);
    await queryRunner.query(
      `ALTER TABLE "jobs" ADD CONSTRAINT "fk_jobs_auto_approve_by_users" FOREIGN KEY ("auto_approve_by") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE NO ACTION`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "jobs" DROP CONSTRAINT "fk_jobs_auto_approve_by_users"`,
    );
    await queryRunner.query(`ALTER TABLE "jobs" DROP COLUMN "auto_approve_by"`);
    await queryRunner.query(`ALTER TABLE "jobs" DROP COLUMN "auto_approve"`);
  }
}
