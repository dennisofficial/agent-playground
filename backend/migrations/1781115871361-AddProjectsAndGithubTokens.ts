import { MigrationInterface, QueryRunner } from "typeorm";

// Generated then PRUNED (per CLAUDE.md): the generator also tried to drop the pgvector HNSW index,
// recreate existing partial/unique indexes under new names, and churn the facts confidence default
// — all noise unrelated to this change. Kept: the two new tables + the single-default partial
// unique index on github_tokens.
export class AddProjectsAndGithubTokens1781115871361 implements MigrationInterface {
    name = 'AddProjectsAndGithubTokens1781115871361'

    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`CREATE TABLE "github_tokens" ("created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), "updated_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), "name" text NOT NULL, "token_ciphertext" text NOT NULL, "is_default" boolean NOT NULL DEFAULT false, CONSTRAINT "pk_github_tokens" PRIMARY KEY ("name"))`);
        await queryRunner.query(`CREATE UNIQUE INDEX "idx_github_tokens_is_default" ON "github_tokens" ("is_default") WHERE is_default`);
        await queryRunner.query(`CREATE TABLE "projects" ("created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), "updated_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), "project_id" text NOT NULL, "display_name" text NOT NULL, "git_url" text NOT NULL, "default_branch" text NOT NULL DEFAULT 'main', "token_name" text, CONSTRAINT "pk_projects" PRIMARY KEY ("project_id"))`);
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`DROP TABLE "projects"`);
        await queryRunner.query(`DROP INDEX "public"."idx_github_tokens_is_default"`);
        await queryRunner.query(`DROP TABLE "github_tokens"`);
    }
}
