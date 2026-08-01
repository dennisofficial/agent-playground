-- CreateSchema
CREATE SCHEMA IF NOT EXISTS "public";

-- CreateEnum
CREATE TYPE "agent_credentials_kind_enum" AS ENUM ('personal', 'setup_token');

-- CreateEnum
CREATE TYPE "agent_credentials_provider_enum" AS ENUM ('claude', 'codex');

-- CreateEnum
CREATE TYPE "agent_credentials_status_enum" AS ENUM ('active', 'needs_reauth', 'error');

-- CreateEnum
CREATE TYPE "inbound_messages_priority_enum" AS ENUM ('now', 'queued', 'later');

-- CreateEnum
CREATE TYPE "inbound_messages_source_enum" AS ENUM ('operator', 'atlas', 'system', 'untrusted');

-- CreateEnum
CREATE TYPE "inbound_messages_status_enum" AS ENUM ('draft', 'pending', 'consumed', 'delivered');

-- CreateEnum
CREATE TYPE "jobs_kind_enum" AS ENUM ('feature', 'bugfix', 'onboarding', 'event', 'review');

-- CreateEnum
CREATE TYPE "jobs_origin_enum" AS ENUM ('chat', 'event', 'control');

-- CreateEnum
CREATE TYPE "jobs_status_enum" AS ENUM ('open', 'planning', 'plan_review', 'awaiting_approval', 'running', 'awaiting_ship_review', 'amending', 'blocked', 'done', 'cancelled', 'deleting', 'archived');

-- CreateEnum
CREATE TYPE "organization_members_role_enum" AS ENUM ('owner', 'member');

-- CreateEnum
CREATE TYPE "organizations_status_enum" AS ENUM ('onboarding', 'active', 'suspended');

-- CreateEnum
CREATE TYPE "repos_default_auto_merge_method_enum" AS ENUM ('merge', 'squash', 'rebase');

-- CreateEnum
CREATE TYPE "subagents_status_enum" AS ENUM ('running', 'done', 'failed');

-- CreateEnum
CREATE TYPE "tasks_status_enum" AS ENUM ('pending', 'in_progress', 'completed', 'dropped');

-- CreateEnum
CREATE TYPE "thread_groups_condition_enum" AS ENUM ('none', 'paused', 'incomplete', 'failed', 'skipped');

-- CreateEnum
CREATE TYPE "thread_groups_kind_enum" AS ENUM ('planning', 'plan_review', 'build', 'direct_build', 'master_review', 'post_build', 'ci');

-- CreateEnum
CREATE TYPE "thread_groups_status_enum" AS ENUM ('pending', 'planning', 'reviewing', 'executing', 'auto_fixing', 'done');

-- CreateEnum
CREATE TYPE "thread_messages_audience_enum" AS ENUM ('operator_only', 'shared');

-- CreateEnum
CREATE TYPE "thread_messages_source_enum" AS ENUM ('operator', 'atlas', 'system', 'untrusted');

-- CreateEnum
CREATE TYPE "thread_messages_type_enum" AS ENUM ('operator', 'answer_question', 'file_answered', 'secret_provided', 'review_comments', 'attachments', 'chat', 'thinking', 'tool', 'approval', 'verdict', 'question', 'secret_request', 'file_request', 'mcp_proposal', 'skill_proposal', 'event', 'compaction', 'untrusted', 'system_shared', 'system_event', 'system_operator', 'system_notice', 'system_reminder', 'build_anchor');

-- CreateEnum
CREATE TYPE "threads_condition_enum" AS ENUM ('none', 'paused', 'incomplete', 'failed', 'skipped');

-- CreateEnum
CREATE TYPE "threads_role_enum" AS ENUM ('planning', 'plan_review', 'builder', 'review_agent', 'review_fix', 'master_review', 'post_build', 'ci');

-- CreateEnum
CREATE TYPE "threads_status_enum" AS ENUM ('pending', 'planning', 'reviewing', 'executing', 'auto_fixing', 'done');

-- CreateEnum
CREATE TYPE "threads_type_enum" AS ENUM ('backend', 'frontend', 'docs', 'testing', 'infra', 'data', 'general');

-- CreateEnum
CREATE TYPE "users_role_enum" AS ENUM ('admin', 'operator');

-- CreateEnum
CREATE TYPE "users_status_enum" AS ENUM ('pending', 'active', 'suspended');

-- CreateEnum
CREATE TYPE "workspace_mounts_mode_enum" AS ENUM ('per-thread', 'shared-ro', 'shared-rw');

-- CreateTable
CREATE TABLE "agent_credentials" (
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "id" UUID NOT NULL DEFAULT uuid_generate_v4(),
    "org_id" UUID NOT NULL,
    "provider" "agent_credentials_provider_enum" NOT NULL,
    "kind" "agent_credentials_kind_enum" NOT NULL,
    "label" TEXT NOT NULL,
    "account_email" TEXT,
    "subscription_type" TEXT,
    "status" "agent_credentials_status_enum" NOT NULL DEFAULT 'active',
    "scopes" TEXT,
    "material_enc" TEXT NOT NULL,
    "expires_at" TIMESTAMPTZ(6),
    "last_refreshed_at" TIMESTAMPTZ(6),
    "selected" BOOLEAN NOT NULL DEFAULT false,
    "usage_snapshot" JSONB,

    CONSTRAINT "pk_agent_credentials" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "inbound_messages" (
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "id" UUID NOT NULL DEFAULT uuid_generate_v4(),
    "org_id" UUID NOT NULL,
    "job_id" UUID NOT NULL,
    "thread_id" UUID NOT NULL,
    "author_id" TEXT NOT NULL,
    "source" "inbound_messages_source_enum" NOT NULL,
    "text" TEXT NOT NULL,
    "payload" JSONB,
    "status" "inbound_messages_status_enum" NOT NULL DEFAULT 'pending',
    "priority" "inbound_messages_priority_enum" NOT NULL DEFAULT 'now',
    "delivered_at" TIMESTAMPTZ(6),

    CONSTRAINT "pk_inbound_messages" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "jobs" (
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "id" UUID NOT NULL DEFAULT uuid_generate_v4(),
    "org_id" UUID NOT NULL,
    "repo_id" UUID NOT NULL,
    "focused_thread_id" UUID,
    "title" TEXT,
    "origin" "jobs_origin_enum" NOT NULL DEFAULT 'chat',
    "kind" "jobs_kind_enum",
    "status" "jobs_status_enum" NOT NULL DEFAULT 'open',
    "archived_at" TIMESTAMPTZ(6),

    CONSTRAINT "pk_jobs" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "mcp_servers" (
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "id" UUID NOT NULL DEFAULT uuid_generate_v4(),
    "org_id" UUID NOT NULL,
    "repo_id" UUID,
    "name" TEXT NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT true,

    CONSTRAINT "pk_mcp_servers" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "org_credentials" (
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "org_id" UUID NOT NULL,
    "anthropic_api_key_enc" TEXT,
    "openai_api_key_enc" TEXT,
    "github_pat_enc" TEXT,
    "github_app_installation_id" TEXT,
    "github_app_installation_account" TEXT,

    CONSTRAINT "pk_org_credentials" PRIMARY KEY ("org_id")
);

-- CreateTable
CREATE TABLE "organization_members" (
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "org_id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "role" "organization_members_role_enum" NOT NULL DEFAULT 'member',

    CONSTRAINT "pk_organization_members" PRIMARY KEY ("org_id","user_id")
);

-- CreateTable
CREATE TABLE "organizations" (
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "id" UUID NOT NULL DEFAULT uuid_generate_v4(),
    "name" TEXT NOT NULL,
    "status" "organizations_status_enum" NOT NULL DEFAULT 'onboarding',
    "default_auto_approve" BOOLEAN NOT NULL DEFAULT false,
    "default_auto_ship" BOOLEAN NOT NULL DEFAULT false,
    "default_auto_merge" BOOLEAN NOT NULL DEFAULT false,

    CONSTRAINT "pk_organizations" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "repos" (
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "id" UUID NOT NULL DEFAULT uuid_generate_v4(),
    "org_id" UUID NOT NULL,
    "slug" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "git_url" TEXT NOT NULL,
    "default_branch" TEXT NOT NULL DEFAULT 'main',
    "branch_prefix" TEXT,
    "default_auto_merge_method" "repos_default_auto_merge_method_enum" NOT NULL DEFAULT 'squash',
    "default_auto_merge_delete_branch" BOOLEAN NOT NULL DEFAULT true,
    "access_ok" BOOLEAN NOT NULL DEFAULT false,
    "access_checked_at" TIMESTAMPTZ(6),
    "webhook_warning" TEXT,
    "onboarding_thread_id" UUID,
    "onboarded_at" TIMESTAMPTZ(6),
    "thread_count" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "pk_repos" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "skills" (
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "id" UUID NOT NULL DEFAULT uuid_generate_v4(),
    "org_id" UUID NOT NULL,
    "repo_id" UUID,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "enabled" BOOLEAN NOT NULL DEFAULT true,

    CONSTRAINT "pk_skills" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "subagents" (
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "id" UUID NOT NULL DEFAULT uuid_generate_v4(),
    "thread_id" UUID NOT NULL,
    "org_id" UUID NOT NULL,
    "parent_message_id" UUID NOT NULL,
    "tool_use_id" TEXT NOT NULL,
    "agent_type" TEXT,
    "model" TEXT,
    "status" "subagents_status_enum" NOT NULL DEFAULT 'running',
    "session_ref" TEXT,
    "input_tokens" INTEGER NOT NULL DEFAULT 0,
    "output_tokens" INTEGER NOT NULL DEFAULT 0,
    "cache_read_tokens" INTEGER NOT NULL DEFAULT 0,
    "cache_write_tokens" INTEGER NOT NULL DEFAULT 0,
    "cost_usd" DOUBLE PRECISION,
    "started_at" TIMESTAMPTZ(6),
    "ended_at" TIMESTAMPTZ(6),

    CONSTRAINT "pk_subagents" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "tasks" (
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "id" UUID NOT NULL DEFAULT uuid_generate_v4(),
    "job_id" UUID NOT NULL,
    "thread_group_id" UUID NOT NULL,
    "org_id" UUID NOT NULL,
    "ordinal" INTEGER NOT NULL,
    "title" TEXT NOT NULL,
    "brief" TEXT,
    "active_form" TEXT,
    "status" "tasks_status_enum" NOT NULL DEFAULT 'pending',
    "blocked_by" JSONB NOT NULL DEFAULT '[]',

    CONSTRAINT "pk_tasks" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "thread_groups" (
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "id" UUID NOT NULL DEFAULT uuid_generate_v4(),
    "job_id" UUID NOT NULL,
    "org_id" UUID NOT NULL,
    "ordinal" INTEGER NOT NULL,
    "kind" "thread_groups_kind_enum" NOT NULL,
    "title" TEXT,
    "type" TEXT,
    "status" "thread_groups_status_enum" NOT NULL DEFAULT 'pending',
    "condition" "thread_groups_condition_enum" NOT NULL DEFAULT 'none',

    CONSTRAINT "pk_thread_groups" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "thread_messages" (
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "id" UUID NOT NULL DEFAULT uuid_generate_v4(),
    "job_id" UUID NOT NULL,
    "thread_id" UUID NOT NULL,
    "org_id" UUID NOT NULL,
    "subagent_id" UUID,
    "source" "thread_messages_source_enum" NOT NULL,
    "author_id" TEXT NOT NULL,
    "text" TEXT NOT NULL,
    "card" JSONB,
    "meta" JSONB,
    "order_at" TIMESTAMPTZ(6),
    "audience" "thread_messages_audience_enum" NOT NULL DEFAULT 'shared',
    "type" "thread_messages_type_enum" NOT NULL DEFAULT 'chat',

    CONSTRAINT "pk_thread_messages" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "threads" (
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "id" UUID NOT NULL DEFAULT uuid_generate_v4(),
    "job_id" UUID NOT NULL,
    "thread_group_id" UUID NOT NULL,
    "org_id" UUID NOT NULL,
    "parent_thread_id" UUID,
    "role" "threads_role_enum" NOT NULL,
    "type" "threads_type_enum" NOT NULL DEFAULT 'general',
    "ordinal" INTEGER NOT NULL,
    "brief" TEXT NOT NULL,
    "status" "threads_status_enum" NOT NULL DEFAULT 'pending',
    "condition" "threads_condition_enum" NOT NULL DEFAULT 'none',
    "session_id" TEXT,

    CONSTRAINT "pk_threads" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "users" (
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "id" UUID NOT NULL DEFAULT uuid_generate_v4(),
    "email" TEXT NOT NULL,
    "password_hash" TEXT NOT NULL,
    "name" TEXT,
    "role" "users_role_enum" NOT NULL DEFAULT 'operator',
    "status" "users_status_enum" NOT NULL DEFAULT 'pending',

    CONSTRAINT "pk_users" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "workspace_mounts" (
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "id" UUID NOT NULL DEFAULT uuid_generate_v4(),
    "org_id" UUID NOT NULL,
    "repo_id" UUID NOT NULL,
    "path" TEXT NOT NULL,
    "mode" "workspace_mounts_mode_enum" NOT NULL DEFAULT 'per-thread',

    CONSTRAINT "pk_workspace_mounts" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "workspace_profiles" (
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "repo_id" UUID NOT NULL,
    "org_id" UUID NOT NULL,
    "setup_script" TEXT,
    "preview_recipe" TEXT,

    CONSTRAINT "pk_workspace_profiles" PRIMARY KEY ("repo_id")
);

-- CreateTable
CREATE TABLE "workspace_secret_files" (
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "id" UUID NOT NULL DEFAULT uuid_generate_v4(),
    "org_id" UUID NOT NULL,
    "repo_id" UUID NOT NULL,
    "path" TEXT NOT NULL,
    "label" TEXT,
    "value_enc" TEXT NOT NULL,

    CONSTRAINT "pk_workspace_secret_files" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "idx_agent_credentials_org_id" ON "agent_credentials"("org_id");

-- CreateIndex
CREATE UNIQUE INDEX "idx_agent_credentials_org_id_provider" ON "agent_credentials"("org_id", "provider") WHERE (selected);

-- CreateIndex
CREATE UNIQUE INDEX "idx_agent_credentials_org_id_provider_account_email" ON "agent_credentials"("org_id", "provider", "account_email") WHERE ((kind = 'personal'::EAgentCredentialKind) AND (account_email IS NOT NULL));

-- CreateIndex
CREATE INDEX "idx_inbound_messages_job_id_status" ON "inbound_messages"("job_id", "status");

-- CreateIndex
CREATE INDEX "idx_inbound_messages_org_id" ON "inbound_messages"("org_id");

-- CreateIndex
CREATE INDEX "idx_jobs_org_id_repo_id" ON "jobs"("org_id", "repo_id");

-- CreateIndex
CREATE INDEX "idx_mcp_servers_org_id" ON "mcp_servers"("org_id");

-- CreateIndex
CREATE INDEX "idx_organization_members_user_id" ON "organization_members"("user_id");

-- CreateIndex
CREATE INDEX "idx_repos_org_id" ON "repos"("org_id");

-- CreateIndex
CREATE UNIQUE INDEX "idx_repos_org_id_slug" ON "repos"("org_id", "slug");

-- CreateIndex
CREATE INDEX "idx_skills_org_id" ON "skills"("org_id");

-- CreateIndex
CREATE INDEX "idx_subagents_org_id" ON "subagents"("org_id");

-- CreateIndex
CREATE INDEX "idx_subagents_parent_message_id" ON "subagents"("parent_message_id");

-- CreateIndex
CREATE INDEX "idx_subagents_thread_id" ON "subagents"("thread_id");

-- CreateIndex
CREATE INDEX "idx_subagents_tool_use_id" ON "subagents"("tool_use_id");

-- CreateIndex
CREATE INDEX "idx_tasks_job_id" ON "tasks"("job_id");

-- CreateIndex
CREATE INDEX "idx_tasks_org_id" ON "tasks"("org_id");

-- CreateIndex
CREATE INDEX "idx_tasks_thread_group_id" ON "tasks"("thread_group_id");

-- CreateIndex
CREATE INDEX "idx_tasks_thread_group_id_ordinal" ON "tasks"("thread_group_id", "ordinal");

-- CreateIndex
CREATE INDEX "idx_thread_groups_job_id" ON "thread_groups"("job_id");

-- CreateIndex
CREATE INDEX "idx_thread_groups_job_id_ordinal" ON "thread_groups"("job_id", "ordinal");

-- CreateIndex
CREATE INDEX "idx_thread_groups_org_id" ON "thread_groups"("org_id");

-- CreateIndex
CREATE INDEX "idx_thread_messages_job_id_created_at" ON "thread_messages"("job_id", "created_at");

-- CreateIndex
CREATE INDEX "idx_thread_messages_org_id" ON "thread_messages"("org_id");

-- CreateIndex
CREATE INDEX "idx_thread_messages_subagent_id" ON "thread_messages"("subagent_id");

-- CreateIndex
CREATE INDEX "idx_thread_messages_thread_id_created_at" ON "thread_messages"("thread_id", "created_at");

-- CreateIndex
CREATE INDEX "idx_threads_job_id" ON "threads"("job_id");

-- CreateIndex
CREATE INDEX "idx_threads_org_id" ON "threads"("org_id");

-- CreateIndex
CREATE INDEX "idx_threads_parent_thread_id" ON "threads"("parent_thread_id");

-- CreateIndex
CREATE INDEX "idx_threads_thread_group_id" ON "threads"("thread_group_id");

-- CreateIndex
CREATE UNIQUE INDEX "idx_users_email" ON "users"("email");

-- CreateIndex
CREATE INDEX "idx_workspace_mounts_org_id" ON "workspace_mounts"("org_id");

-- CreateIndex
CREATE UNIQUE INDEX "idx_workspace_mounts_repo_id_path" ON "workspace_mounts"("repo_id", "path");

-- CreateIndex
CREATE INDEX "idx_workspace_profiles_org_id" ON "workspace_profiles"("org_id");

-- CreateIndex
CREATE INDEX "idx_workspace_secret_files_org_id" ON "workspace_secret_files"("org_id");

-- CreateIndex
CREATE UNIQUE INDEX "idx_workspace_secret_files_repo_id_path" ON "workspace_secret_files"("repo_id", "path");

-- AddForeignKey
ALTER TABLE "agent_credentials" ADD CONSTRAINT "fk_agent_credentials_org_id_organizations" FOREIGN KEY ("org_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "inbound_messages" ADD CONSTRAINT "fk_inbound_messages_job_id_jobs" FOREIGN KEY ("job_id") REFERENCES "jobs"("id") ON DELETE CASCADE ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "inbound_messages" ADD CONSTRAINT "fk_inbound_messages_org_id_organizations" FOREIGN KEY ("org_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "inbound_messages" ADD CONSTRAINT "fk_inbound_messages_thread_id_threads" FOREIGN KEY ("thread_id") REFERENCES "threads"("id") ON DELETE CASCADE ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "jobs" ADD CONSTRAINT "fk_jobs_focused_thread_id_threads" FOREIGN KEY ("focused_thread_id") REFERENCES "threads"("id") ON DELETE SET NULL ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "jobs" ADD CONSTRAINT "fk_jobs_org_id_organizations" FOREIGN KEY ("org_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "jobs" ADD CONSTRAINT "fk_jobs_repo_id_repos" FOREIGN KEY ("repo_id") REFERENCES "repos"("id") ON DELETE CASCADE ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "org_credentials" ADD CONSTRAINT "fk_org_credentials_org_id_organizations" FOREIGN KEY ("org_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "organization_members" ADD CONSTRAINT "fk_organization_members_org_id_organizations" FOREIGN KEY ("org_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "organization_members" ADD CONSTRAINT "fk_organization_members_user_id_users" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "repos" ADD CONSTRAINT "fk_repos_org_id_organizations" FOREIGN KEY ("org_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "subagents" ADD CONSTRAINT "fk_subagents_org_id_organizations" FOREIGN KEY ("org_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "subagents" ADD CONSTRAINT "fk_subagents_parent_message_id_thread_messages" FOREIGN KEY ("parent_message_id") REFERENCES "thread_messages"("id") ON DELETE CASCADE ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "subagents" ADD CONSTRAINT "fk_subagents_thread_id_threads" FOREIGN KEY ("thread_id") REFERENCES "threads"("id") ON DELETE CASCADE ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "tasks" ADD CONSTRAINT "fk_tasks_job_id_jobs" FOREIGN KEY ("job_id") REFERENCES "jobs"("id") ON DELETE CASCADE ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "tasks" ADD CONSTRAINT "fk_tasks_org_id_organizations" FOREIGN KEY ("org_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "tasks" ADD CONSTRAINT "fk_tasks_thread_group_id_thread_groups" FOREIGN KEY ("thread_group_id") REFERENCES "thread_groups"("id") ON DELETE CASCADE ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "thread_groups" ADD CONSTRAINT "fk_thread_groups_job_id_jobs" FOREIGN KEY ("job_id") REFERENCES "jobs"("id") ON DELETE CASCADE ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "thread_groups" ADD CONSTRAINT "fk_thread_groups_org_id_organizations" FOREIGN KEY ("org_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "thread_messages" ADD CONSTRAINT "fk_thread_messages_job_id_jobs" FOREIGN KEY ("job_id") REFERENCES "jobs"("id") ON DELETE CASCADE ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "thread_messages" ADD CONSTRAINT "fk_thread_messages_org_id_organizations" FOREIGN KEY ("org_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "thread_messages" ADD CONSTRAINT "fk_thread_messages_subagent_id_subagents" FOREIGN KEY ("subagent_id") REFERENCES "subagents"("id") ON DELETE CASCADE ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "thread_messages" ADD CONSTRAINT "fk_thread_messages_thread_id_threads" FOREIGN KEY ("thread_id") REFERENCES "threads"("id") ON DELETE CASCADE ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "threads" ADD CONSTRAINT "fk_threads_job_id_jobs" FOREIGN KEY ("job_id") REFERENCES "jobs"("id") ON DELETE CASCADE ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "threads" ADD CONSTRAINT "fk_threads_org_id_organizations" FOREIGN KEY ("org_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "threads" ADD CONSTRAINT "fk_threads_parent_thread_id_threads" FOREIGN KEY ("parent_thread_id") REFERENCES "threads"("id") ON DELETE CASCADE ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "threads" ADD CONSTRAINT "fk_threads_thread_group_id_thread_groups" FOREIGN KEY ("thread_group_id") REFERENCES "thread_groups"("id") ON DELETE CASCADE ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "workspace_mounts" ADD CONSTRAINT "fk_workspace_mounts_repo_id_repos" FOREIGN KEY ("repo_id") REFERENCES "repos"("id") ON DELETE CASCADE ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "workspace_profiles" ADD CONSTRAINT "fk_workspace_profiles_repo_id_repos" FOREIGN KEY ("repo_id") REFERENCES "repos"("id") ON DELETE CASCADE ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "workspace_secret_files" ADD CONSTRAINT "fk_workspace_secret_files_repo_id_repos" FOREIGN KEY ("repo_id") REFERENCES "repos"("id") ON DELETE CASCADE ON UPDATE NO ACTION;

