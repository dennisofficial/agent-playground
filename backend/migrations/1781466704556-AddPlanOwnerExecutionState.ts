import { MigrationInterface, QueryRunner } from "typeorm";

export class AddPlanOwnerExecutionState1781466704556 implements MigrationInterface {
    name = 'AddPlanOwnerExecutionState1781466704556'

    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`ALTER TABLE "team_task_plans" ADD "owner_status" text NOT NULL DEFAULT 'executing'`);
        await queryRunner.query(`ALTER TABLE "team_task_plans" ADD "execute_worktree_id" text`);
        await queryRunner.query(`ALTER TABLE "team_task_plans" ADD "shared_branch" text`);
        await queryRunner.query(`ALTER TABLE "team_task_plans" ADD "pr_url" text`);
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`ALTER TABLE "team_task_plans" DROP COLUMN "pr_url"`);
        await queryRunner.query(`ALTER TABLE "team_task_plans" DROP COLUMN "shared_branch"`);
        await queryRunner.query(`ALTER TABLE "team_task_plans" DROP COLUMN "execute_worktree_id"`);
        await queryRunner.query(`ALTER TABLE "team_task_plans" DROP COLUMN "owner_status"`);
    }

}
