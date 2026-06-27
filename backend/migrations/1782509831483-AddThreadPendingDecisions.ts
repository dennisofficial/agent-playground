import { MigrationInterface, QueryRunner } from "typeorm";

/**
 * The grilling WORKING SET of logged decisions (`log_decision` → `threads.pending_decisions`), kept
 * separate from `decision_records` so the proposal lifecycle (fresh record + supersede per submit_plan)
 * stays intact. `submit_plan` snapshots this set into a new decision record. JSONB `Decision[]`.
 *
 * `IF NOT EXISTS` because the shared dev DB already had this column (added out-of-band); fresh/test DBs
 * need it added here.
 */
export class AddThreadPendingDecisions1782509831483 implements MigrationInterface {
    name = 'AddThreadPendingDecisions1782509831483'

    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(
            `ALTER TABLE "threads" ADD COLUMN IF NOT EXISTS "pending_decisions" jsonb NOT NULL DEFAULT '[]'::jsonb`,
        );
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`ALTER TABLE "threads" DROP COLUMN IF EXISTS "pending_decisions"`);
    }

}
