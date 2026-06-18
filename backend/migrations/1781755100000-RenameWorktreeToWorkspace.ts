import { MigrationInterface, QueryRunner } from "typeorm";

/**
 * Product-concept rename worktree → workspace. Clean column RENAMEs (data preserved — never
 * drop/add), plus the sessions index rename so TypeORM's next `migration:generate` sees no drift.
 */
export class RenameWorktreeToWorkspace1781755100000 implements MigrationInterface {
    name = 'RenameWorktreeToWorkspace1781755100000'

    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`ALTER TABLE "sessions" RENAME COLUMN "worktree_id" TO "workspace_id"`);
        await queryRunner.query(`ALTER INDEX "idx_sessions_worktree_id" RENAME TO "idx_sessions_workspace_id"`);
        await queryRunner.query(`ALTER TABLE "pipeline_runs" RENAME COLUMN "worktree_id" TO "workspace_id"`);
        await queryRunner.query(`ALTER TABLE "team_task_plans" RENAME COLUMN "execute_worktree_id" TO "execute_workspace_id"`);
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`ALTER TABLE "team_task_plans" RENAME COLUMN "execute_workspace_id" TO "execute_worktree_id"`);
        await queryRunner.query(`ALTER TABLE "pipeline_runs" RENAME COLUMN "workspace_id" TO "worktree_id"`);
        await queryRunner.query(`ALTER INDEX "idx_sessions_workspace_id" RENAME TO "idx_sessions_worktree_id"`);
        await queryRunner.query(`ALTER TABLE "sessions" RENAME COLUMN "workspace_id" TO "worktree_id"`);
    }

}
