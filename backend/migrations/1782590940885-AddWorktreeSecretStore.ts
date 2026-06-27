import { MigrationInterface, QueryRunner } from "typeorm";

export class AddWorktreeSecretStore1782590940885 implements MigrationInterface {
    name = 'AddWorktreeSecretStore1782590940885'

    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`CREATE TABLE "org_worktree_secrets" ("created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), "updated_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), "org_id" uuid NOT NULL, "name" text NOT NULL, "value_enc" text NOT NULL, CONSTRAINT "pk_org_worktree_secrets" PRIMARY KEY ("org_id", "name"))`);
        await queryRunner.query(`CREATE INDEX "idx_org_worktree_secrets_org_id" ON "org_worktree_secrets" ("org_id") `);
        await queryRunner.query(`CREATE TABLE "org_worktree_secret_grants" ("created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), "updated_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), "org_id" uuid NOT NULL, "repo_id" uuid NOT NULL, "name" text NOT NULL, "path" text NOT NULL, CONSTRAINT "pk_org_worktree_secret_grants" PRIMARY KEY ("org_id", "repo_id", "name", "path"))`);
        await queryRunner.query(`CREATE INDEX "idx_org_worktree_secret_grants_org_id_repo_id" ON "org_worktree_secret_grants" ("org_id", "repo_id") `);
        await queryRunner.query(`CREATE INDEX "idx_org_worktree_secret_grants_org_id" ON "org_worktree_secret_grants" ("org_id") `);
        await queryRunner.query(`ALTER TABLE "thread_sandboxes" ADD "hydration_sig" text`);
        await queryRunner.query(`ALTER TABLE "org_worktree_secrets" ADD CONSTRAINT "fk_org_worktree_secrets_org_id_organizations" FOREIGN KEY ("org_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE NO ACTION`);
        await queryRunner.query(`ALTER TABLE "org_worktree_secret_grants" ADD CONSTRAINT "fk_org_worktree_secret_grants_org_id_organizations" FOREIGN KEY ("org_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE NO ACTION`);
        await queryRunner.query(`ALTER TABLE "org_worktree_secret_grants" ADD CONSTRAINT "fk_org_worktree_secret_grants_repo_id_repos" FOREIGN KEY ("repo_id") REFERENCES "repos"("id") ON DELETE CASCADE ON UPDATE NO ACTION`);
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`ALTER TABLE "org_worktree_secret_grants" DROP CONSTRAINT "fk_org_worktree_secret_grants_repo_id_repos"`);
        await queryRunner.query(`ALTER TABLE "org_worktree_secret_grants" DROP CONSTRAINT "fk_org_worktree_secret_grants_org_id_organizations"`);
        await queryRunner.query(`ALTER TABLE "org_worktree_secrets" DROP CONSTRAINT "fk_org_worktree_secrets_org_id_organizations"`);
        await queryRunner.query(`ALTER TABLE "thread_sandboxes" DROP COLUMN "hydration_sig"`);
        await queryRunner.query(`DROP INDEX "public"."idx_org_worktree_secret_grants_org_id"`);
        await queryRunner.query(`DROP INDEX "public"."idx_org_worktree_secret_grants_org_id_repo_id"`);
        await queryRunner.query(`DROP TABLE "org_worktree_secret_grants"`);
        await queryRunner.query(`DROP INDEX "public"."idx_org_worktree_secrets_org_id"`);
        await queryRunner.query(`DROP TABLE "org_worktree_secrets"`);
    }

}
