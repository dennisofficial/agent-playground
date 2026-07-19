import { MigrationInterface, QueryRunner } from 'typeorm';

export class AddJobsAndThreads1784420379281 implements MigrationInterface {
  name = 'AddJobsAndThreads1784420379281';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `CREATE TYPE "public"."jobs_origin_enum" AS ENUM('chat', 'event', 'control')`,
    );
    await queryRunner.query(
      `CREATE TYPE "public"."jobs_kind_enum" AS ENUM('feature', 'bugfix', 'onboarding', 'event', 'review')`,
    );
    await queryRunner.query(
      `CREATE TYPE "public"."jobs_status_enum" AS ENUM('open', 'planning', 'plan_review', 'awaiting_approval', 'running', 'awaiting_ship_review', 'amending', 'blocked', 'done', 'cancelled', 'deleting', 'archived')`,
    );
    await queryRunner.query(
      `CREATE TYPE "public"."jobs_activity_enum" AS ENUM('idle', 'turn', 'plan_review', 'build', 'master_review', 'base_check', 'retrying')`,
    );
    await queryRunner.query(
      `CREATE TABLE "jobs" ("created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), "updated_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), "id" uuid NOT NULL DEFAULT uuid_generate_v4(), "org_id" uuid NOT NULL, "repo_id" uuid NOT NULL, "focused_thread_id" uuid, "title" text, "origin" "public"."jobs_origin_enum" NOT NULL DEFAULT 'chat', "kind" "public"."jobs_kind_enum", "status" "public"."jobs_status_enum" NOT NULL DEFAULT 'open', "activity" "public"."jobs_activity_enum" NOT NULL DEFAULT 'idle', "archived_at" TIMESTAMP WITH TIME ZONE, CONSTRAINT "pk_jobs" PRIMARY KEY ("id"))`,
    );
    await queryRunner.query(
      `CREATE INDEX "idx_jobs_org_id_repo_id" ON "jobs" ("org_id", "repo_id") `,
    );
    await queryRunner.query(
      `CREATE TYPE "public"."thread_groups_kind_enum" AS ENUM('planning', 'plan_review', 'build', 'direct_build', 'master_review', 'post_build', 'ci')`,
    );
    await queryRunner.query(
      `CREATE TYPE "public"."thread_groups_status_enum" AS ENUM('pending', 'planning', 'reviewing', 'executing', 'auto_fixing', 'done')`,
    );
    await queryRunner.query(
      `CREATE TYPE "public"."thread_groups_condition_enum" AS ENUM('none', 'paused', 'incomplete', 'failed', 'skipped')`,
    );
    await queryRunner.query(
      `CREATE TABLE "thread_groups" ("created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), "updated_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), "id" uuid NOT NULL DEFAULT uuid_generate_v4(), "job_id" uuid NOT NULL, "org_id" uuid NOT NULL, "ordinal" integer NOT NULL, "kind" "public"."thread_groups_kind_enum" NOT NULL, "title" text, "type" text, "status" "public"."thread_groups_status_enum" NOT NULL DEFAULT 'pending', "condition" "public"."thread_groups_condition_enum" NOT NULL DEFAULT 'none', CONSTRAINT "pk_thread_groups" PRIMARY KEY ("id"))`,
    );
    await queryRunner.query(
      `CREATE INDEX "idx_thread_groups_org_id" ON "thread_groups" ("org_id") `,
    );
    await queryRunner.query(
      `CREATE INDEX "idx_thread_groups_job_id_ordinal" ON "thread_groups" ("job_id", "ordinal") `,
    );
    await queryRunner.query(
      `CREATE INDEX "idx_thread_groups_job_id" ON "thread_groups" ("job_id") `,
    );
    await queryRunner.query(
      `CREATE TYPE "public"."threads_role_enum" AS ENUM('planning', 'plan_review', 'builder', 'review_agent', 'review_fix', 'master_review', 'post_build', 'ci')`,
    );
    await queryRunner.query(
      `CREATE TYPE "public"."threads_type_enum" AS ENUM('backend', 'frontend', 'docs', 'testing', 'infra', 'data', 'general')`,
    );
    await queryRunner.query(
      `CREATE TYPE "public"."threads_status_enum" AS ENUM('pending', 'planning', 'reviewing', 'executing', 'auto_fixing', 'done')`,
    );
    await queryRunner.query(
      `CREATE TYPE "public"."threads_condition_enum" AS ENUM('none', 'paused', 'incomplete', 'failed', 'skipped')`,
    );
    await queryRunner.query(
      `CREATE TABLE "threads" ("created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), "updated_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), "id" uuid NOT NULL DEFAULT uuid_generate_v4(), "job_id" uuid NOT NULL, "thread_group_id" uuid NOT NULL, "org_id" uuid NOT NULL, "parent_thread_id" uuid, "role" "public"."threads_role_enum" NOT NULL, "type" "public"."threads_type_enum" NOT NULL DEFAULT 'general', "ordinal" integer NOT NULL, "brief" text NOT NULL, "status" "public"."threads_status_enum" NOT NULL DEFAULT 'pending', "condition" "public"."threads_condition_enum" NOT NULL DEFAULT 'none', "session_id" text, CONSTRAINT "pk_threads" PRIMARY KEY ("id"))`,
    );
    await queryRunner.query(`CREATE INDEX "idx_threads_org_id" ON "threads" ("org_id") `);
    await queryRunner.query(
      `CREATE INDEX "idx_threads_parent_thread_id" ON "threads" ("parent_thread_id") `,
    );
    await queryRunner.query(
      `CREATE INDEX "idx_threads_thread_group_id" ON "threads" ("thread_group_id") `,
    );
    await queryRunner.query(`CREATE INDEX "idx_threads_job_id" ON "threads" ("job_id") `);
    await queryRunner.query(
      `CREATE TYPE "public"."subagents_status_enum" AS ENUM('running', 'done', 'failed')`,
    );
    await queryRunner.query(
      `CREATE TABLE "subagents" ("created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), "updated_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), "id" uuid NOT NULL DEFAULT uuid_generate_v4(), "thread_id" uuid NOT NULL, "org_id" uuid NOT NULL, "parent_message_id" uuid NOT NULL, "tool_use_id" text NOT NULL, "agent_type" text, "model" text, "status" "public"."subagents_status_enum" NOT NULL DEFAULT 'running', "session_ref" text, "input_tokens" integer NOT NULL DEFAULT '0', "output_tokens" integer NOT NULL DEFAULT '0', "cache_read_tokens" integer NOT NULL DEFAULT '0', "cache_write_tokens" integer NOT NULL DEFAULT '0', "cost_usd" double precision, "started_at" TIMESTAMP WITH TIME ZONE, "ended_at" TIMESTAMP WITH TIME ZONE, CONSTRAINT "pk_subagents" PRIMARY KEY ("id"))`,
    );
    await queryRunner.query(`CREATE INDEX "idx_subagents_org_id" ON "subagents" ("org_id") `);
    await queryRunner.query(
      `CREATE INDEX "idx_subagents_parent_message_id" ON "subagents" ("parent_message_id") `,
    );
    await queryRunner.query(
      `CREATE INDEX "idx_subagents_tool_use_id" ON "subagents" ("tool_use_id") `,
    );
    await queryRunner.query(`CREATE INDEX "idx_subagents_thread_id" ON "subagents" ("thread_id") `);
    await queryRunner.query(
      `CREATE TYPE "public"."thread_messages_source_enum" AS ENUM('operator', 'atlas', 'system_operator', 'system_shared', 'system_event', 'system_notice', 'system_reminder', 'untrusted')`,
    );
    await queryRunner.query(
      `CREATE TYPE "public"."thread_messages_kind_enum" AS ENUM('chat', 'thinking', 'tool', 'card', 'build_event')`,
    );
    await queryRunner.query(
      `CREATE TABLE "thread_messages" ("created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), "updated_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), "id" uuid NOT NULL DEFAULT uuid_generate_v4(), "job_id" uuid NOT NULL, "thread_id" uuid NOT NULL, "org_id" uuid NOT NULL, "subagent_id" uuid, "source" "public"."thread_messages_source_enum" NOT NULL, "author_id" text NOT NULL, "author" text NOT NULL, "text" text NOT NULL, "kind" "public"."thread_messages_kind_enum" NOT NULL DEFAULT 'chat', "card" jsonb, "meta" jsonb, "order_at" TIMESTAMP WITH TIME ZONE, CONSTRAINT "pk_thread_messages" PRIMARY KEY ("id"))`,
    );
    await queryRunner.query(
      `CREATE INDEX "idx_thread_messages_org_id" ON "thread_messages" ("org_id") `,
    );
    await queryRunner.query(
      `CREATE INDEX "idx_thread_messages_subagent_id" ON "thread_messages" ("subagent_id") `,
    );
    await queryRunner.query(
      `CREATE INDEX "idx_thread_messages_thread_id_created_at" ON "thread_messages" ("thread_id", "created_at") `,
    );
    await queryRunner.query(
      `CREATE INDEX "idx_thread_messages_job_id_created_at" ON "thread_messages" ("job_id", "created_at") `,
    );
    await queryRunner.query(
      `CREATE TYPE "public"."tasks_status_enum" AS ENUM('pending', 'in_progress', 'completed', 'dropped')`,
    );
    await queryRunner.query(
      `CREATE TABLE "tasks" ("created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), "updated_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), "id" uuid NOT NULL DEFAULT uuid_generate_v4(), "job_id" uuid NOT NULL, "thread_group_id" uuid NOT NULL, "org_id" uuid NOT NULL, "ordinal" integer NOT NULL, "title" text NOT NULL, "brief" text, "active_form" text, "status" "public"."tasks_status_enum" NOT NULL DEFAULT 'pending', "blocked_by" jsonb NOT NULL DEFAULT '[]', CONSTRAINT "pk_tasks" PRIMARY KEY ("id"))`,
    );
    await queryRunner.query(`CREATE INDEX "idx_tasks_org_id" ON "tasks" ("org_id") `);
    await queryRunner.query(`CREATE INDEX "idx_tasks_job_id" ON "tasks" ("job_id") `);
    await queryRunner.query(
      `CREATE INDEX "idx_tasks_thread_group_id_ordinal" ON "tasks" ("thread_group_id", "ordinal") `,
    );
    await queryRunner.query(
      `CREATE INDEX "idx_tasks_thread_group_id" ON "tasks" ("thread_group_id") `,
    );
    await queryRunner.query(
      `ALTER TABLE "jobs" ADD CONSTRAINT "fk_jobs_org_id_organizations" FOREIGN KEY ("org_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE NO ACTION`,
    );
    await queryRunner.query(
      `ALTER TABLE "jobs" ADD CONSTRAINT "fk_jobs_repo_id_repos" FOREIGN KEY ("repo_id") REFERENCES "repos"("id") ON DELETE CASCADE ON UPDATE NO ACTION`,
    );
    await queryRunner.query(
      `ALTER TABLE "jobs" ADD CONSTRAINT "fk_jobs_focused_thread_id_threads" FOREIGN KEY ("focused_thread_id") REFERENCES "threads"("id") ON DELETE SET NULL ON UPDATE NO ACTION`,
    );
    await queryRunner.query(
      `ALTER TABLE "thread_groups" ADD CONSTRAINT "fk_thread_groups_job_id_jobs" FOREIGN KEY ("job_id") REFERENCES "jobs"("id") ON DELETE CASCADE ON UPDATE NO ACTION`,
    );
    await queryRunner.query(
      `ALTER TABLE "thread_groups" ADD CONSTRAINT "fk_thread_groups_org_id_organizations" FOREIGN KEY ("org_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE NO ACTION`,
    );
    await queryRunner.query(
      `ALTER TABLE "threads" ADD CONSTRAINT "fk_threads_job_id_jobs" FOREIGN KEY ("job_id") REFERENCES "jobs"("id") ON DELETE CASCADE ON UPDATE NO ACTION`,
    );
    await queryRunner.query(
      `ALTER TABLE "threads" ADD CONSTRAINT "fk_threads_thread_group_id_thread_groups" FOREIGN KEY ("thread_group_id") REFERENCES "thread_groups"("id") ON DELETE CASCADE ON UPDATE NO ACTION`,
    );
    await queryRunner.query(
      `ALTER TABLE "threads" ADD CONSTRAINT "fk_threads_org_id_organizations" FOREIGN KEY ("org_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE NO ACTION`,
    );
    await queryRunner.query(
      `ALTER TABLE "threads" ADD CONSTRAINT "fk_threads_parent_thread_id_threads" FOREIGN KEY ("parent_thread_id") REFERENCES "threads"("id") ON DELETE CASCADE ON UPDATE NO ACTION`,
    );
    await queryRunner.query(
      `ALTER TABLE "subagents" ADD CONSTRAINT "fk_subagents_thread_id_threads" FOREIGN KEY ("thread_id") REFERENCES "threads"("id") ON DELETE CASCADE ON UPDATE NO ACTION`,
    );
    await queryRunner.query(
      `ALTER TABLE "subagents" ADD CONSTRAINT "fk_subagents_org_id_organizations" FOREIGN KEY ("org_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE NO ACTION`,
    );
    await queryRunner.query(
      `ALTER TABLE "subagents" ADD CONSTRAINT "fk_subagents_parent_message_id_thread_messages" FOREIGN KEY ("parent_message_id") REFERENCES "thread_messages"("id") ON DELETE CASCADE ON UPDATE NO ACTION`,
    );
    await queryRunner.query(
      `ALTER TABLE "thread_messages" ADD CONSTRAINT "fk_thread_messages_job_id_jobs" FOREIGN KEY ("job_id") REFERENCES "jobs"("id") ON DELETE CASCADE ON UPDATE NO ACTION`,
    );
    await queryRunner.query(
      `ALTER TABLE "thread_messages" ADD CONSTRAINT "fk_thread_messages_thread_id_threads" FOREIGN KEY ("thread_id") REFERENCES "threads"("id") ON DELETE CASCADE ON UPDATE NO ACTION`,
    );
    await queryRunner.query(
      `ALTER TABLE "thread_messages" ADD CONSTRAINT "fk_thread_messages_org_id_organizations" FOREIGN KEY ("org_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE NO ACTION`,
    );
    await queryRunner.query(
      `ALTER TABLE "thread_messages" ADD CONSTRAINT "fk_thread_messages_subagent_id_subagents" FOREIGN KEY ("subagent_id") REFERENCES "subagents"("id") ON DELETE CASCADE ON UPDATE NO ACTION`,
    );
    await queryRunner.query(
      `ALTER TABLE "tasks" ADD CONSTRAINT "fk_tasks_job_id_jobs" FOREIGN KEY ("job_id") REFERENCES "jobs"("id") ON DELETE CASCADE ON UPDATE NO ACTION`,
    );
    await queryRunner.query(
      `ALTER TABLE "tasks" ADD CONSTRAINT "fk_tasks_thread_group_id_thread_groups" FOREIGN KEY ("thread_group_id") REFERENCES "thread_groups"("id") ON DELETE CASCADE ON UPDATE NO ACTION`,
    );
    await queryRunner.query(
      `ALTER TABLE "tasks" ADD CONSTRAINT "fk_tasks_org_id_organizations" FOREIGN KEY ("org_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE NO ACTION`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "tasks" DROP CONSTRAINT "fk_tasks_org_id_organizations"`);
    await queryRunner.query(
      `ALTER TABLE "tasks" DROP CONSTRAINT "fk_tasks_thread_group_id_thread_groups"`,
    );
    await queryRunner.query(`ALTER TABLE "tasks" DROP CONSTRAINT "fk_tasks_job_id_jobs"`);
    await queryRunner.query(
      `ALTER TABLE "thread_messages" DROP CONSTRAINT "fk_thread_messages_subagent_id_subagents"`,
    );
    await queryRunner.query(
      `ALTER TABLE "thread_messages" DROP CONSTRAINT "fk_thread_messages_org_id_organizations"`,
    );
    await queryRunner.query(
      `ALTER TABLE "thread_messages" DROP CONSTRAINT "fk_thread_messages_thread_id_threads"`,
    );
    await queryRunner.query(
      `ALTER TABLE "thread_messages" DROP CONSTRAINT "fk_thread_messages_job_id_jobs"`,
    );
    await queryRunner.query(
      `ALTER TABLE "subagents" DROP CONSTRAINT "fk_subagents_parent_message_id_thread_messages"`,
    );
    await queryRunner.query(
      `ALTER TABLE "subagents" DROP CONSTRAINT "fk_subagents_org_id_organizations"`,
    );
    await queryRunner.query(
      `ALTER TABLE "subagents" DROP CONSTRAINT "fk_subagents_thread_id_threads"`,
    );
    await queryRunner.query(
      `ALTER TABLE "threads" DROP CONSTRAINT "fk_threads_parent_thread_id_threads"`,
    );
    await queryRunner.query(
      `ALTER TABLE "threads" DROP CONSTRAINT "fk_threads_org_id_organizations"`,
    );
    await queryRunner.query(
      `ALTER TABLE "threads" DROP CONSTRAINT "fk_threads_thread_group_id_thread_groups"`,
    );
    await queryRunner.query(`ALTER TABLE "threads" DROP CONSTRAINT "fk_threads_job_id_jobs"`);
    await queryRunner.query(
      `ALTER TABLE "thread_groups" DROP CONSTRAINT "fk_thread_groups_org_id_organizations"`,
    );
    await queryRunner.query(
      `ALTER TABLE "thread_groups" DROP CONSTRAINT "fk_thread_groups_job_id_jobs"`,
    );
    await queryRunner.query(
      `ALTER TABLE "jobs" DROP CONSTRAINT "fk_jobs_focused_thread_id_threads"`,
    );
    await queryRunner.query(`ALTER TABLE "jobs" DROP CONSTRAINT "fk_jobs_repo_id_repos"`);
    await queryRunner.query(`ALTER TABLE "jobs" DROP CONSTRAINT "fk_jobs_org_id_organizations"`);
    await queryRunner.query(`DROP INDEX "public"."idx_tasks_thread_group_id"`);
    await queryRunner.query(`DROP INDEX "public"."idx_tasks_thread_group_id_ordinal"`);
    await queryRunner.query(`DROP INDEX "public"."idx_tasks_job_id"`);
    await queryRunner.query(`DROP INDEX "public"."idx_tasks_org_id"`);
    await queryRunner.query(`DROP TABLE "tasks"`);
    await queryRunner.query(`DROP TYPE "public"."tasks_status_enum"`);
    await queryRunner.query(`DROP INDEX "public"."idx_thread_messages_job_id_created_at"`);
    await queryRunner.query(`DROP INDEX "public"."idx_thread_messages_thread_id_created_at"`);
    await queryRunner.query(`DROP INDEX "public"."idx_thread_messages_subagent_id"`);
    await queryRunner.query(`DROP INDEX "public"."idx_thread_messages_org_id"`);
    await queryRunner.query(`DROP TABLE "thread_messages"`);
    await queryRunner.query(`DROP TYPE "public"."thread_messages_kind_enum"`);
    await queryRunner.query(`DROP TYPE "public"."thread_messages_source_enum"`);
    await queryRunner.query(`DROP INDEX "public"."idx_subagents_thread_id"`);
    await queryRunner.query(`DROP INDEX "public"."idx_subagents_tool_use_id"`);
    await queryRunner.query(`DROP INDEX "public"."idx_subagents_parent_message_id"`);
    await queryRunner.query(`DROP INDEX "public"."idx_subagents_org_id"`);
    await queryRunner.query(`DROP TABLE "subagents"`);
    await queryRunner.query(`DROP TYPE "public"."subagents_status_enum"`);
    await queryRunner.query(`DROP INDEX "public"."idx_threads_job_id"`);
    await queryRunner.query(`DROP INDEX "public"."idx_threads_thread_group_id"`);
    await queryRunner.query(`DROP INDEX "public"."idx_threads_parent_thread_id"`);
    await queryRunner.query(`DROP INDEX "public"."idx_threads_org_id"`);
    await queryRunner.query(`DROP TABLE "threads"`);
    await queryRunner.query(`DROP TYPE "public"."threads_condition_enum"`);
    await queryRunner.query(`DROP TYPE "public"."threads_status_enum"`);
    await queryRunner.query(`DROP TYPE "public"."threads_type_enum"`);
    await queryRunner.query(`DROP TYPE "public"."threads_role_enum"`);
    await queryRunner.query(`DROP INDEX "public"."idx_thread_groups_job_id"`);
    await queryRunner.query(`DROP INDEX "public"."idx_thread_groups_job_id_ordinal"`);
    await queryRunner.query(`DROP INDEX "public"."idx_thread_groups_org_id"`);
    await queryRunner.query(`DROP TABLE "thread_groups"`);
    await queryRunner.query(`DROP TYPE "public"."thread_groups_condition_enum"`);
    await queryRunner.query(`DROP TYPE "public"."thread_groups_status_enum"`);
    await queryRunner.query(`DROP TYPE "public"."thread_groups_kind_enum"`);
    await queryRunner.query(`DROP INDEX "public"."idx_jobs_org_id_repo_id"`);
    await queryRunner.query(`DROP TABLE "jobs"`);
    await queryRunner.query(`DROP TYPE "public"."jobs_activity_enum"`);
    await queryRunner.query(`DROP TYPE "public"."jobs_status_enum"`);
    await queryRunner.query(`DROP TYPE "public"."jobs_kind_enum"`);
    await queryRunner.query(`DROP TYPE "public"."jobs_origin_enum"`);
  }
}
