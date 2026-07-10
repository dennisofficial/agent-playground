import { MigrationInterface, QueryRunner } from "typeorm";

export class AddThreadCondition1783600100000 implements MigrationInterface {
    name = 'AddThreadCondition1783600100000'

    public async up(queryRunner: QueryRunner): Promise<void> {
        // Split the conflated thread `status` into a pure linear STEP + an orthogonal `condition` overlay,
        // mirroring the job-level `job-status-phase-vs-halt` split (failed→done+halt, paused→running+halt).
        await queryRunner.query(`ALTER TABLE "threads" ADD "condition" text NOT NULL DEFAULT 'none'`);
        // Backfill the overlay from the old conflated status values FIRST...
        await queryRunner.query(`UPDATE "threads" SET condition = 'paused'     WHERE status = 'awaiting_input'`);
        await queryRunner.query(`UPDATE "threads" SET condition = 'paused'     WHERE status = 'awaiting_approval'`);
        await queryRunner.query(`UPDATE "threads" SET condition = 'incomplete' WHERE status = 'incomplete'`);
        await queryRunner.query(`UPDATE "threads" SET condition = 'failed'     WHERE status = 'failed'`);
        await queryRunner.query(`UPDATE "threads" SET condition = 'skipped'    WHERE status = 'skipped'`);
        // ...then collapse the removed status values onto their linear step.
        await queryRunner.query(`UPDATE "threads" SET status = 'executing' WHERE status IN ('awaiting_input', 'incomplete', 'failed')`);
        await queryRunner.query(`UPDATE "threads" SET status = 'planning'  WHERE status = 'awaiting_approval'`);
        await queryRunner.query(`UPDATE "threads" SET status = 'reviewing' WHERE status = 'skipped'`);
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        // Best-effort, LOSSY inverse: this is a forward-only enum cleanup, so folding the overlay back into
        // status only approximates the pre-split rows (the original step under a terminal condition is gone).
        await queryRunner.query(`UPDATE "threads" SET status = 'failed'           WHERE condition = 'failed'`);
        await queryRunner.query(`UPDATE "threads" SET status = 'incomplete'       WHERE condition = 'incomplete'`);
        await queryRunner.query(`UPDATE "threads" SET status = 'awaiting_input'   WHERE condition = 'paused' AND status = 'executing'`);
        await queryRunner.query(`UPDATE "threads" SET status = 'awaiting_approval' WHERE condition = 'paused' AND status = 'planning'`);
        await queryRunner.query(`UPDATE "threads" SET status = 'skipped'          WHERE condition = 'skipped' AND status = 'reviewing'`);
        await queryRunner.query(`ALTER TABLE "threads" DROP COLUMN "condition"`);
    }

}
