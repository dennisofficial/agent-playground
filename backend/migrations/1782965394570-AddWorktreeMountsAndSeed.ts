import { MigrationInterface, QueryRunner } from 'typeorm';

export class AddWorktreeMountsAndSeed1782965394570 implements MigrationInterface {
  name = 'AddWorktreeMountsAndSeed1782965394570';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `CREATE TABLE "org_worktree_mounts" ("created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), "updated_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), "org_id" uuid NOT NULL, "repo_id" uuid NOT NULL, "path" text NOT NULL, "mode" text NOT NULL, CONSTRAINT "pk_org_worktree_mounts" PRIMARY KEY ("org_id", "repo_id", "path"))`,
    );
    await queryRunner.query(
      `CREATE INDEX "idx_org_worktree_mounts_org_id_repo_id" ON "org_worktree_mounts" ("org_id", "repo_id") `,
    );
    await queryRunner.query(
      `CREATE INDEX "idx_org_worktree_mounts_org_id" ON "org_worktree_mounts" ("org_id") `,
    );
    await queryRunner.query(
      `CREATE TABLE "org_worktree_seed" ("created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), "updated_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), "org_id" uuid NOT NULL, "repo_id" uuid NOT NULL, "path" text NOT NULL, CONSTRAINT "pk_org_worktree_seed" PRIMARY KEY ("org_id", "repo_id", "path"))`,
    );
    await queryRunner.query(
      `CREATE INDEX "idx_org_worktree_seed_org_id_repo_id" ON "org_worktree_seed" ("org_id", "repo_id") `,
    );
    await queryRunner.query(
      `CREATE INDEX "idx_org_worktree_seed_org_id" ON "org_worktree_seed" ("org_id") `,
    );
    await queryRunner.query(
      `ALTER TABLE "org_worktree_mounts" ADD CONSTRAINT "fk_org_worktree_mounts_org_id_organizations" FOREIGN KEY ("org_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE NO ACTION`,
    );
    await queryRunner.query(
      `ALTER TABLE "org_worktree_mounts" ADD CONSTRAINT "fk_org_worktree_mounts_repo_id_repos" FOREIGN KEY ("repo_id") REFERENCES "repos"("id") ON DELETE CASCADE ON UPDATE NO ACTION`,
    );
    await queryRunner.query(
      `ALTER TABLE "org_worktree_seed" ADD CONSTRAINT "fk_org_worktree_seed_org_id_organizations" FOREIGN KEY ("org_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE NO ACTION`,
    );
    await queryRunner.query(
      `ALTER TABLE "org_worktree_seed" ADD CONSTRAINT "fk_org_worktree_seed_repo_id_repos" FOREIGN KEY ("repo_id") REFERENCES "repos"("id") ON DELETE CASCADE ON UPDATE NO ACTION`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "org_worktree_seed" DROP CONSTRAINT "fk_org_worktree_seed_repo_id_repos"`,
    );
    await queryRunner.query(
      `ALTER TABLE "org_worktree_seed" DROP CONSTRAINT "fk_org_worktree_seed_org_id_organizations"`,
    );
    await queryRunner.query(
      `ALTER TABLE "org_worktree_mounts" DROP CONSTRAINT "fk_org_worktree_mounts_repo_id_repos"`,
    );
    await queryRunner.query(
      `ALTER TABLE "org_worktree_mounts" DROP CONSTRAINT "fk_org_worktree_mounts_org_id_organizations"`,
    );
    await queryRunner.query(
      `DROP INDEX "public"."idx_org_worktree_seed_org_id"`,
    );
    await queryRunner.query(
      `DROP INDEX "public"."idx_org_worktree_seed_org_id_repo_id"`,
    );
    await queryRunner.query(`DROP TABLE "org_worktree_seed"`);
    await queryRunner.query(
      `DROP INDEX "public"."idx_org_worktree_mounts_org_id"`,
    );
    await queryRunner.query(
      `DROP INDEX "public"."idx_org_worktree_mounts_org_id_repo_id"`,
    );
    await queryRunner.query(`DROP TABLE "org_worktree_mounts"`);
  }
}
