import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Rename the two "worktree" data-layer tables to "workspace" so the whole Workspace Profile config
 * layer speaks one name (the umbrella was already "Workspace Profile" in the prompt/read-model).
 *
 * DATA-PRESERVING: the generator wanted DROP+CREATE (which would lose live rows) — hand-rewritten to
 * `ALTER TABLE … RENAME`, and its unrelated noise (a `jobs.halted` add owned by AddJobHalted, and the
 * recurring HNSW / partial-unique-index churn) was pruned. Renaming a PK constraint also renames its
 * backing index; the two secondary `idx_` indexes are renamed explicitly.
 */
export class RenameWorktreeToWorkspace1783559326944 implements MigrationInterface {
  name = 'RenameWorktreeToWorkspace1783559326944';

  public async up(queryRunner: QueryRunner): Promise<void> {
    // Tables
    await queryRunner.query(
      `ALTER TABLE "org_worktree_secret_files" RENAME TO "org_workspace_secret_files"`,
    );
    await queryRunner.query(
      `ALTER TABLE "org_worktree_mounts" RENAME TO "org_workspace_mounts"`,
    );
    // Primary keys (renames the backing index too)
    await queryRunner.query(
      `ALTER TABLE "org_workspace_secret_files" RENAME CONSTRAINT "pk_org_worktree_secret_files" TO "pk_org_workspace_secret_files"`,
    );
    await queryRunner.query(
      `ALTER TABLE "org_workspace_mounts" RENAME CONSTRAINT "pk_org_worktree_mounts" TO "pk_org_workspace_mounts"`,
    );
    // Foreign keys
    await queryRunner.query(
      `ALTER TABLE "org_workspace_secret_files" RENAME CONSTRAINT "fk_org_worktree_secret_files_org_id_organizations" TO "fk_org_workspace_secret_files_org_id_organizations"`,
    );
    await queryRunner.query(
      `ALTER TABLE "org_workspace_secret_files" RENAME CONSTRAINT "fk_org_worktree_secret_files_repo_id_repos" TO "fk_org_workspace_secret_files_repo_id_repos"`,
    );
    await queryRunner.query(
      `ALTER TABLE "org_workspace_mounts" RENAME CONSTRAINT "fk_org_worktree_mounts_org_id_organizations" TO "fk_org_workspace_mounts_org_id_organizations"`,
    );
    await queryRunner.query(
      `ALTER TABLE "org_workspace_mounts" RENAME CONSTRAINT "fk_org_worktree_mounts_repo_id_repos" TO "fk_org_workspace_mounts_repo_id_repos"`,
    );
    // Secondary indexes
    await queryRunner.query(
      `ALTER INDEX "idx_org_worktree_secret_files_org_id" RENAME TO "idx_org_workspace_secret_files_org_id"`,
    );
    await queryRunner.query(
      `ALTER INDEX "idx_org_worktree_secret_files_org_id_repo_id" RENAME TO "idx_org_workspace_secret_files_org_id_repo_id"`,
    );
    await queryRunner.query(
      `ALTER INDEX "idx_org_worktree_mounts_org_id" RENAME TO "idx_org_workspace_mounts_org_id"`,
    );
    await queryRunner.query(
      `ALTER INDEX "idx_org_worktree_mounts_org_id_repo_id" RENAME TO "idx_org_workspace_mounts_org_id_repo_id"`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER INDEX "idx_org_workspace_mounts_org_id_repo_id" RENAME TO "idx_org_worktree_mounts_org_id_repo_id"`,
    );
    await queryRunner.query(
      `ALTER INDEX "idx_org_workspace_mounts_org_id" RENAME TO "idx_org_worktree_mounts_org_id"`,
    );
    await queryRunner.query(
      `ALTER INDEX "idx_org_workspace_secret_files_org_id_repo_id" RENAME TO "idx_org_worktree_secret_files_org_id_repo_id"`,
    );
    await queryRunner.query(
      `ALTER INDEX "idx_org_workspace_secret_files_org_id" RENAME TO "idx_org_worktree_secret_files_org_id"`,
    );
    await queryRunner.query(
      `ALTER TABLE "org_workspace_mounts" RENAME CONSTRAINT "fk_org_workspace_mounts_repo_id_repos" TO "fk_org_worktree_mounts_repo_id_repos"`,
    );
    await queryRunner.query(
      `ALTER TABLE "org_workspace_mounts" RENAME CONSTRAINT "fk_org_workspace_mounts_org_id_organizations" TO "fk_org_worktree_mounts_org_id_organizations"`,
    );
    await queryRunner.query(
      `ALTER TABLE "org_workspace_secret_files" RENAME CONSTRAINT "fk_org_workspace_secret_files_repo_id_repos" TO "fk_org_worktree_secret_files_repo_id_repos"`,
    );
    await queryRunner.query(
      `ALTER TABLE "org_workspace_secret_files" RENAME CONSTRAINT "fk_org_workspace_secret_files_org_id_organizations" TO "fk_org_worktree_secret_files_org_id_organizations"`,
    );
    await queryRunner.query(
      `ALTER TABLE "org_workspace_mounts" RENAME CONSTRAINT "pk_org_workspace_mounts" TO "pk_org_worktree_mounts"`,
    );
    await queryRunner.query(
      `ALTER TABLE "org_workspace_secret_files" RENAME CONSTRAINT "pk_org_workspace_secret_files" TO "pk_org_worktree_secret_files"`,
    );
    await queryRunner.query(
      `ALTER TABLE "org_workspace_mounts" RENAME TO "org_worktree_mounts"`,
    );
    await queryRunner.query(
      `ALTER TABLE "org_workspace_secret_files" RENAME TO "org_worktree_secret_files"`,
    );
  }
}
