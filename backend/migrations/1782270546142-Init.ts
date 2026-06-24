import { MigrationInterface, QueryRunner } from "typeorm";

export class Init1782270546142 implements MigrationInterface {
    name = 'Init1782270546142'

    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`CREATE EXTENSION IF NOT EXISTS "uuid-ossp"`);
        await queryRunner.query(`CREATE EXTENSION IF NOT EXISTS "vector"`);
        await queryRunner.query(`CREATE TABLE "organizations" ("created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), "updated_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), "id" text NOT NULL, "name" text NOT NULL, "slug" text NOT NULL, "status" text NOT NULL DEFAULT 'onboarding', CONSTRAINT "pk_organizations" PRIMARY KEY ("id"))`);
        await queryRunner.query(`CREATE UNIQUE INDEX "idx_organizations_slug" ON "organizations" ("slug") `);
        await queryRunner.query(`CREATE TABLE "organization_members" ("created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), "updated_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), "org_id" text NOT NULL, "user_id" text NOT NULL, "role" text NOT NULL DEFAULT 'member', CONSTRAINT "pk_organization_members" PRIMARY KEY ("org_id", "user_id"))`);
        await queryRunner.query(`CREATE INDEX "idx_organization_members_user_id" ON "organization_members" ("user_id") `);
        await queryRunner.query(`CREATE TABLE "org_invites" ("created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), "updated_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), "token" text NOT NULL, "org_id" text NOT NULL, "email" text NOT NULL, "role" text NOT NULL DEFAULT 'member', "invited_by" text NOT NULL, "accepted_at" TIMESTAMP WITH TIME ZONE, "accepted_by" text, CONSTRAINT "pk_org_invites" PRIMARY KEY ("token"))`);
        await queryRunner.query(`CREATE INDEX "idx_org_invites_email" ON "org_invites" ("email") `);
        await queryRunner.query(`CREATE INDEX "idx_org_invites_org_id" ON "org_invites" ("org_id") `);
        await queryRunner.query(`CREATE TABLE "repos" ("created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), "updated_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), "org_id" text NOT NULL, "repo_id" text NOT NULL, "name" text NOT NULL, "git_url" text NOT NULL, "default_branch" text NOT NULL DEFAULT 'main', "token_name" text, "access_ok" boolean NOT NULL DEFAULT false, "access_checked_at" TIMESTAMP WITH TIME ZONE, CONSTRAINT "pk_repos" PRIMARY KEY ("org_id", "repo_id"))`);
        await queryRunner.query(`CREATE INDEX "idx_repos_org_id" ON "repos" ("org_id") `);
        await queryRunner.query(`CREATE TABLE "threads" ("created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), "updated_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), "id" uuid NOT NULL DEFAULT uuid_generate_v4(), "org_id" text NOT NULL, "repo_id" text NOT NULL, "origin" text NOT NULL, "surface_thread_ref" text, "title" text, "base_branch" text, CONSTRAINT "pk_threads" PRIMARY KEY ("id"))`);
        await queryRunner.query(`CREATE INDEX "idx_threads_org_id_repo_id" ON "threads" ("org_id", "repo_id") `);
        await queryRunner.query(`CREATE TABLE "messages" ("created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), "updated_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), "id" uuid NOT NULL DEFAULT uuid_generate_v4(), "thread_id" uuid NOT NULL, "author" text NOT NULL, "author_id" text NOT NULL, "author_bot_id" text, "text" text NOT NULL, "ts" text, "kind" text NOT NULL DEFAULT 'chat', "card" jsonb, "meta" jsonb, CONSTRAINT "pk_messages" PRIMARY KEY ("id"))`);
        await queryRunner.query(`CREATE INDEX "idx_messages_thread_id_created_at" ON "messages" ("thread_id", "created_at") `);
        await queryRunner.query(`CREATE TABLE "stimuli" ("created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), "updated_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), "id" uuid NOT NULL DEFAULT uuid_generate_v4(), "org_id" text NOT NULL, "repo_id" text NOT NULL, "kind" text NOT NULL, "trust" text NOT NULL, "body" text NOT NULL, "thread_id" uuid, "author_id" text, "reply_route" jsonb, "source" text, "dedupe_key" text, "severity" text, CONSTRAINT "pk_stimuli" PRIMARY KEY ("id"))`);
        await queryRunner.query(`CREATE UNIQUE INDEX "idx_stimuli_org_id_repo_id_source_dedupe_key" ON "stimuli" ("org_id", "repo_id", "source", "dedupe_key") WHERE "kind" = 'event'`);
        await queryRunner.query(`CREATE INDEX "idx_stimuli_org_id_repo_id" ON "stimuli" ("org_id", "repo_id") `);
        await queryRunner.query(`CREATE TABLE "jobs" ("created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), "updated_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), "id" uuid NOT NULL DEFAULT uuid_generate_v4(), "org_id" text NOT NULL, "repo_id" text NOT NULL, "thread_id" uuid NOT NULL, "kind" text NOT NULL DEFAULT 'feature', "status" text NOT NULL DEFAULT 'scoping', "title" text NOT NULL, "decision_record_id" uuid, "feature_branch" text, "pr_url" text, CONSTRAINT "pk_jobs" PRIMARY KEY ("id"))`);
        await queryRunner.query(`CREATE INDEX "idx_jobs_org_id_status" ON "jobs" ("org_id", "status") `);
        await queryRunner.query(`CREATE INDEX "idx_jobs_org_id_repo_id" ON "jobs" ("org_id", "repo_id") `);
        await queryRunner.query(`CREATE TABLE "sections" ("created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), "updated_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), "id" uuid NOT NULL DEFAULT uuid_generate_v4(), "job_id" uuid NOT NULL, "org_id" text NOT NULL, "ordinal" integer NOT NULL, "brief" text NOT NULL, "plan" text, "handoff_in" text, "handoff_out" text, "status" text NOT NULL DEFAULT 'pending', CONSTRAINT "uq_sections_job_id_ordinal" UNIQUE ("job_id", "ordinal"), CONSTRAINT "pk_sections" PRIMARY KEY ("id"))`);
        await queryRunner.query(`CREATE INDEX "idx_sections_job_id" ON "sections" ("job_id") `);
        await queryRunner.query(`CREATE TABLE "phases" ("created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), "updated_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), "id" uuid NOT NULL DEFAULT uuid_generate_v4(), "section_id" uuid NOT NULL, "job_id" uuid NOT NULL, "org_id" text NOT NULL, "ordinal" integer NOT NULL, "title" text, "brief" text NOT NULL, "step" text NOT NULL DEFAULT 'build', "status" text NOT NULL DEFAULT 'pending', "session_id" text, CONSTRAINT "uq_phases_section_id_ordinal" UNIQUE ("section_id", "ordinal"), CONSTRAINT "pk_phases" PRIMARY KEY ("id"))`);
        await queryRunner.query(`CREATE INDEX "idx_phases_job_id" ON "phases" ("job_id") `);
        await queryRunner.query(`CREATE INDEX "idx_phases_section_id" ON "phases" ("section_id") `);
        await queryRunner.query(`CREATE TABLE "decision_records" ("created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), "updated_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), "id" uuid NOT NULL DEFAULT uuid_generate_v4(), "org_id" text NOT NULL, "repo_id" text NOT NULL, "job_id" uuid NOT NULL, "status" text NOT NULL DEFAULT 'draft', "overview" text NOT NULL, "decisions" jsonb NOT NULL DEFAULT '[]'::jsonb, "section_briefs" text array NOT NULL DEFAULT '{}', "approved_by" text, "approved_at" TIMESTAMP WITH TIME ZONE, CONSTRAINT "pk_decision_records" PRIMARY KEY ("id"))`);
        await queryRunner.query(`CREATE INDEX "idx_decision_records_job_id" ON "decision_records" ("job_id") `);
        await queryRunner.query(`CREATE INDEX "idx_decision_records_org_id_repo_id" ON "decision_records" ("org_id", "repo_id") `);
        await queryRunner.query(`CREATE TABLE "memory" ("created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), "updated_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), "id" SERIAL NOT NULL, "fact" text NOT NULL, "embedding" vector(1536) NOT NULL, "org_id" text, "scope" text NOT NULL, "asserted_by" text, "confidence" real NOT NULL DEFAULT '1', "embed_model" text, "deleted_at" TIMESTAMP WITH TIME ZONE, CONSTRAINT "pk_memory" PRIMARY KEY ("id"))`);
        await queryRunner.query(`CREATE INDEX "idx_memory_org_id_scope" ON "memory" ("org_id", "scope") `);
        await queryRunner.query(`CREATE INDEX "idx_memory_scope" ON "memory" ("scope") `);
        await queryRunner.query(`CREATE INDEX "idx_memory_embedding_hnsw" ON "memory" USING hnsw ("embedding" vector_cosine_ops)`);
        await queryRunner.query(`CREATE TABLE "org_credentials" ("created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), "updated_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), "org_id" text NOT NULL, "scope" text NOT NULL DEFAULT '*', "anthropic_api_key_enc" text, "openai_api_key_enc" text, "github_pat_enc" text, "engine_auth_mode" text NOT NULL DEFAULT 'api_key', "engine_auth_secret_enc" text, "llm_validated_at" TIMESTAMP WITH TIME ZONE, CONSTRAINT "pk_org_credentials" PRIMARY KEY ("org_id", "scope"))`);
        await queryRunner.query(`CREATE INDEX "idx_org_credentials_org_id" ON "org_credentials" ("org_id") `);
        await queryRunner.query(`CREATE TABLE "thread_sandboxes" ("created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), "updated_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), "id" uuid NOT NULL DEFAULT uuid_generate_v4(), "org_id" text NOT NULL, "thread_id" uuid NOT NULL, "repo_id" text NOT NULL, "base_branch" text NOT NULL, "feature_branch" text, "worktree_path" text NOT NULL, "container_id" text, "lifecycle" text NOT NULL DEFAULT 'provisioning', "session_id" text, "last_active_at" TIMESTAMP WITH TIME ZONE, "pr_url" text, "pr_number" integer, CONSTRAINT "pk_thread_sandboxes" PRIMARY KEY ("id"))`);
        await queryRunner.query(`CREATE UNIQUE INDEX "idx_thread_sandboxes_org_id_thread_id" ON "thread_sandboxes" ("org_id", "thread_id") `);
        await queryRunner.query(`CREATE TABLE "users" ("created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), "updated_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), "id" uuid NOT NULL DEFAULT uuid_generate_v4(), "email" text NOT NULL, "password_hash" text NOT NULL, "name" text, "role" text NOT NULL DEFAULT 'operator', CONSTRAINT "pk_users" PRIMARY KEY ("id"))`);
        await queryRunner.query(`CREATE UNIQUE INDEX "idx_users_email" ON "users" ("email") `);
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`DROP INDEX "public"."idx_users_email"`);
        await queryRunner.query(`DROP TABLE "users"`);
        await queryRunner.query(`DROP INDEX "public"."idx_thread_sandboxes_org_id_thread_id"`);
        await queryRunner.query(`DROP TABLE "thread_sandboxes"`);
        await queryRunner.query(`DROP INDEX "public"."idx_org_credentials_org_id"`);
        await queryRunner.query(`DROP TABLE "org_credentials"`);
        await queryRunner.query(`DROP INDEX "public"."idx_memory_embedding_hnsw"`);
        await queryRunner.query(`DROP INDEX "public"."idx_memory_scope"`);
        await queryRunner.query(`DROP INDEX "public"."idx_memory_org_id_scope"`);
        await queryRunner.query(`DROP TABLE "memory"`);
        await queryRunner.query(`DROP INDEX "public"."idx_decision_records_org_id_repo_id"`);
        await queryRunner.query(`DROP INDEX "public"."idx_decision_records_job_id"`);
        await queryRunner.query(`DROP TABLE "decision_records"`);
        await queryRunner.query(`DROP INDEX "public"."idx_phases_section_id"`);
        await queryRunner.query(`DROP INDEX "public"."idx_phases_job_id"`);
        await queryRunner.query(`DROP TABLE "phases"`);
        await queryRunner.query(`DROP INDEX "public"."idx_sections_job_id"`);
        await queryRunner.query(`DROP TABLE "sections"`);
        await queryRunner.query(`DROP INDEX "public"."idx_jobs_org_id_repo_id"`);
        await queryRunner.query(`DROP INDEX "public"."idx_jobs_org_id_status"`);
        await queryRunner.query(`DROP TABLE "jobs"`);
        await queryRunner.query(`DROP INDEX "public"."idx_stimuli_org_id_repo_id"`);
        await queryRunner.query(`DROP INDEX "public"."idx_stimuli_org_id_repo_id_source_dedupe_key"`);
        await queryRunner.query(`DROP TABLE "stimuli"`);
        await queryRunner.query(`DROP INDEX "public"."idx_messages_thread_id_created_at"`);
        await queryRunner.query(`DROP TABLE "messages"`);
        await queryRunner.query(`DROP INDEX "public"."idx_threads_org_id_repo_id"`);
        await queryRunner.query(`DROP TABLE "threads"`);
        await queryRunner.query(`DROP INDEX "public"."idx_repos_org_id"`);
        await queryRunner.query(`DROP TABLE "repos"`);
        await queryRunner.query(`DROP INDEX "public"."idx_org_invites_org_id"`);
        await queryRunner.query(`DROP INDEX "public"."idx_org_invites_email"`);
        await queryRunner.query(`DROP TABLE "org_invites"`);
        await queryRunner.query(`DROP INDEX "public"."idx_organization_members_user_id"`);
        await queryRunner.query(`DROP TABLE "organization_members"`);
        await queryRunner.query(`DROP INDEX "public"."idx_organizations_slug"`);
        await queryRunner.query(`DROP TABLE "organizations"`);
    }

}
