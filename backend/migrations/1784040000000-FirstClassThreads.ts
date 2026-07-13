import { MigrationInterface, QueryRunner } from "typeorm";

/**
 * FIRST-CLASS THREADS — the one-way backfilling migration that reshapes the old
 * job/thread/step model into the new stage → thread → subagent hierarchy.
 *
 * It introduces `stages` (the pipeline grouping every thread now belongs to), `tasks` (the
 * stage-owned checklist that replaces both `threads.tasks` and `jobs.main_tasks` jsonb), and
 * `subagents` (the normalized replacement for the ad-hoc `meta.parentToolUseId ↔ meta.id`
 * pointers on `messages`). It relocates the resume/commit anchors off `steps` onto `threads`,
 * renames `threads.kind`→`role`, backfills `messages.thread_id`, then drops `steps`,
 * `build_legs`, and `codex_reviews`.
 *
 * ONE-WAY / STRUCTURAL: `down()` restores the SHAPE only (the three dropped tables come back
 * EMPTY, the dropped columns come back nullable) — it does NOT reconstruct any backfilled data.
 * The forward backfill (exploding jsonb into rows, folding step anchors into threads, rewriting
 * `meta.phaseId` from step-id to thread-id) is not reversible; a re-run of `up()` after a
 * `down()` still works schema-wise, which is all `down()` guarantees.
 */
export class FirstClassThreads1784040000000 implements MigrationInterface {
    name = 'FirstClassThreads1784040000000'

    public async up(queryRunner: QueryRunner): Promise<void> {
        // ── Step 1: create stages, tasks, subagents (+ indexes, FKs) ──────────────────────────
        await queryRunner.query(`CREATE TABLE "stages" ("created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), "updated_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), "id" uuid NOT NULL DEFAULT uuid_generate_v4(), "job_id" uuid NOT NULL, "org_id" uuid NOT NULL, "ordinal" integer NOT NULL, "kind" text NOT NULL, "title" text, "type" text, "status" text NOT NULL DEFAULT 'pending', "condition" text NOT NULL DEFAULT 'none', "decision_record_id" uuid, "config" jsonb NOT NULL DEFAULT '{}', CONSTRAINT "pk_stages" PRIMARY KEY ("id"))`);
        await queryRunner.query(`CREATE INDEX "idx_stages_job_id" ON "stages" ("job_id") `);
        await queryRunner.query(`CREATE INDEX "idx_stages_job_id_ordinal" ON "stages" ("job_id", "ordinal") `);
        await queryRunner.query(`CREATE INDEX "idx_stages_decision_record_id" ON "stages" ("decision_record_id") `);
        await queryRunner.query(`ALTER TABLE "stages" ADD CONSTRAINT "fk_stages_job_id_jobs" FOREIGN KEY ("job_id") REFERENCES "jobs"("id") ON DELETE CASCADE ON UPDATE NO ACTION`);
        await queryRunner.query(`ALTER TABLE "stages" ADD CONSTRAINT "fk_stages_org_id_organizations" FOREIGN KEY ("org_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE NO ACTION`);
        await queryRunner.query(`ALTER TABLE "stages" ADD CONSTRAINT "fk_stages_decision_record_id_decision_records" FOREIGN KEY ("decision_record_id") REFERENCES "decision_records"("id") ON DELETE CASCADE ON UPDATE NO ACTION`);

        await queryRunner.query(`CREATE TABLE "tasks" ("created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), "updated_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), "id" uuid NOT NULL DEFAULT uuid_generate_v4(), "stage_id" uuid NOT NULL, "org_id" uuid NOT NULL, "ordinal" integer NOT NULL, "title" text NOT NULL, "brief" text, "active_form" text, "status" text NOT NULL DEFAULT 'pending', "blocked_by" jsonb NOT NULL DEFAULT '[]', CONSTRAINT "pk_tasks" PRIMARY KEY ("id"))`);
        await queryRunner.query(`CREATE INDEX "idx_tasks_stage_id" ON "tasks" ("stage_id") `);
        await queryRunner.query(`CREATE INDEX "idx_tasks_stage_id_ordinal" ON "tasks" ("stage_id", "ordinal") `);
        await queryRunner.query(`ALTER TABLE "tasks" ADD CONSTRAINT "fk_tasks_stage_id_stages" FOREIGN KEY ("stage_id") REFERENCES "stages"("id") ON DELETE CASCADE ON UPDATE NO ACTION`);
        await queryRunner.query(`ALTER TABLE "tasks" ADD CONSTRAINT "fk_tasks_org_id_organizations" FOREIGN KEY ("org_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE NO ACTION`);

        await queryRunner.query(`CREATE TABLE "subagents" ("created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), "updated_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), "id" uuid NOT NULL DEFAULT uuid_generate_v4(), "thread_id" uuid NOT NULL, "parent_message_id" uuid NOT NULL, "tool_use_id" text NOT NULL, "agent_type" text, "model" text, "status" text NOT NULL DEFAULT 'running', "session_ref" text, "input_tokens" bigint NOT NULL DEFAULT '0', "output_tokens" bigint NOT NULL DEFAULT '0', "cache_read_tokens" bigint NOT NULL DEFAULT '0', "cache_write_tokens" bigint NOT NULL DEFAULT '0', "cost_usd" numeric, "started_at" TIMESTAMP WITH TIME ZONE, "ended_at" TIMESTAMP WITH TIME ZONE, CONSTRAINT "pk_subagents" PRIMARY KEY ("id"))`);
        await queryRunner.query(`CREATE INDEX "idx_subagents_thread_id" ON "subagents" ("thread_id") `);
        await queryRunner.query(`CREATE INDEX "idx_subagents_tool_use_id" ON "subagents" ("tool_use_id") `);
        await queryRunner.query(`CREATE INDEX "idx_subagents_parent_message_id" ON "subagents" ("parent_message_id") `);
        await queryRunner.query(`ALTER TABLE "subagents" ADD CONSTRAINT "fk_subagents_thread_id_threads" FOREIGN KEY ("thread_id") REFERENCES "threads"("id") ON DELETE CASCADE ON UPDATE NO ACTION`);
        await queryRunner.query(`ALTER TABLE "subagents" ADD CONSTRAINT "fk_subagents_parent_message_id_messages" FOREIGN KEY ("parent_message_id") REFERENCES "messages"("id") ON DELETE CASCADE ON UPDATE NO ACTION`);

        // ── Step 2: add the new (nullable) columns; rename threads.kind → role ─────────────────
        await queryRunner.query(`ALTER TABLE "threads" ADD "stage_id" uuid`);
        await queryRunner.query(`ALTER TABLE "threads" ADD "session_id" text`);
        await queryRunner.query(`ALTER TABLE "threads" ADD "commit_sha" text`);
        await queryRunner.query(`ALTER TABLE "threads" RENAME COLUMN "kind" TO "role"`);
        await queryRunner.query(`CREATE INDEX "idx_threads_stage_id" ON "threads" ("stage_id") `);
        await queryRunner.query(`ALTER TABLE "threads" ADD CONSTRAINT "fk_threads_stage_id_stages" FOREIGN KEY ("stage_id") REFERENCES "stages"("id") ON DELETE CASCADE ON UPDATE NO ACTION`);

        await queryRunner.query(`ALTER TABLE "messages" ADD "thread_id" uuid`);
        await queryRunner.query(`ALTER TABLE "messages" ADD "subagent_id" uuid`);
        await queryRunner.query(`CREATE INDEX "idx_messages_thread_id_created_at" ON "messages" ("thread_id", "created_at") `);
        await queryRunner.query(`CREATE INDEX "idx_messages_subagent_id" ON "messages" ("subagent_id") `);
        await queryRunner.query(`ALTER TABLE "messages" ADD CONSTRAINT "fk_messages_thread_id_threads" FOREIGN KEY ("thread_id") REFERENCES "threads"("id") ON DELETE CASCADE ON UPDATE NO ACTION`);
        await queryRunner.query(`ALTER TABLE "messages" ADD CONSTRAINT "fk_messages_subagent_id_subagents" FOREIGN KEY ("subagent_id") REFERENCES "subagents"("id") ON DELETE CASCADE ON UPDATE NO ACTION`);

        // NOTE: the `role` column still holds the OLD kind values ('main' | 'builder' | 'review_lens'
        // | 'post_review' | 'plan_review' | 'master_review') until step 4 remaps them. Steps 3-4 read
        // those old values to group threads into stages BEFORE rewriting them.

        // ── Step 3: backfill stages — one stage per pipeline unit ─────────────────────────────
        // 3a. A planning stage for EVERY job (unconditional — guarantees step 7's per-job fallback).
        await queryRunner.query(`
            INSERT INTO "stages" ("id", "job_id", "org_id", "ordinal", "kind", "status", "condition", "config")
            SELECT uuid_generate_v4(), j."id", j."org_id",
                   COALESCE((SELECT MIN(t."ordinal") FROM "threads" t WHERE t."job_id" = j."id" AND t."role" = 'main'), 10),
                   'planning', 'pending', 'none', '{}'
            FROM "jobs" j
        `);
        // Convert an existing role='main' thread onto its job's planning stage (role → 'planning').
        await queryRunner.query(`
            UPDATE "threads" t SET "role" = 'planning', "stage_id" = s."id"
            FROM "stages" s
            WHERE s."kind" = 'planning' AND s."job_id" = t."job_id" AND t."role" = 'main'
        `);
        // Synthesize a fresh planning thread for any planning stage still without one (orphan/chat jobs).
        await queryRunner.query(`
            INSERT INTO "threads" ("id", "job_id", "org_id", "stage_id", "ordinal", "brief", "role")
            SELECT uuid_generate_v4(), s."job_id", s."org_id", s."id", s."ordinal", 'Planning', 'planning'
            FROM "stages" s
            WHERE s."kind" = 'planning' AND NOT EXISTS (SELECT 1 FROM "threads" t WHERE t."stage_id" = s."id")
        `);

        // 3b. A plan_review stage per job that has a codex_reviews row.
        await queryRunner.query(`
            INSERT INTO "stages" ("id", "job_id", "org_id", "ordinal", "kind", "status", "condition", "config")
            SELECT uuid_generate_v4(), cr."job_id", cr."org_id",
                   COALESCE((SELECT MIN(t."ordinal") FROM "threads" t WHERE t."job_id" = cr."job_id" AND t."role" = 'plan_review'), 20),
                   'plan_review', 'pending', 'none', '{}'
            FROM (SELECT DISTINCT "job_id", "org_id" FROM "codex_reviews") cr
        `);
        // Point an existing plan_review thread at the plan_review stage; synthesize one otherwise.
        await queryRunner.query(`
            UPDATE "threads" t SET "stage_id" = s."id"
            FROM "stages" s
            WHERE s."kind" = 'plan_review' AND s."job_id" = t."job_id" AND t."role" = 'plan_review'
        `);
        await queryRunner.query(`
            INSERT INTO "threads" ("id", "job_id", "org_id", "stage_id", "ordinal", "brief", "role")
            SELECT uuid_generate_v4(), s."job_id", s."org_id", s."id", s."ordinal", 'Plan review', 'plan_review'
            FROM "stages" s
            WHERE s."kind" = 'plan_review' AND NOT EXISTS (SELECT 1 FROM "threads" t WHERE t."stage_id" = s."id")
        `);
        // Fold the codex_reviews row into its plan_review thread (session_id + config).
        await queryRunner.query(`
            UPDATE "threads" t SET
                "session_id" = cr."codex_session_id",
                "config" = t."config" || jsonb_build_object(
                    'specHash', cr."spec_hash",
                    'resumeCount', cr."resume_count",
                    'findings', cr."findings",
                    'error', cr."error",
                    'codexStatus', cr."status"
                )
            FROM "stages" s, "codex_reviews" cr
            WHERE t."stage_id" = s."id" AND s."kind" = 'plan_review' AND cr."job_id" = s."job_id"
        `);

        // 3c. A build stage per top-level builder thread; group the builder + its review children under it.
        await queryRunner.query(`
            WITH builders AS (
                SELECT "id" AS builder_id, "job_id", "org_id", "ordinal", "brief", "type", "decision_record_id",
                       uuid_generate_v4() AS stage_id
                FROM "threads"
                WHERE "role" = 'builder' AND "parent_thread_id" IS NULL
            ),
            ins_stages AS (
                INSERT INTO "stages" ("id", "job_id", "org_id", "ordinal", "kind", "title", "type", "status", "condition", "decision_record_id", "config")
                SELECT stage_id, "job_id", "org_id", "ordinal", 'build', "brief", "type", 'pending', 'none', "decision_record_id", '{}'
                FROM builders
            ),
            link_builder AS (
                UPDATE "threads" t SET "stage_id" = b.stage_id FROM builders b WHERE t."id" = b.builder_id
                RETURNING 1
            )
            UPDATE "threads" t SET "stage_id" = b.stage_id
            FROM builders b WHERE t."parent_thread_id" = b.builder_id
        `);

        // 3d. A master_review stage per master_review thread. Carries decision_record_id (+ config)
        // from the source thread — the sole mechanism distinguishing one plan revision's completed
        // work from another's (d7); threads.decision_record_id is dropped in step 11, so this is the
        // only chance to relocate it onto the stage.
        await queryRunner.query(`
            WITH mr AS (
                SELECT "id" AS thread_id, "job_id", "org_id", "ordinal", "decision_record_id", "config",
                       uuid_generate_v4() AS stage_id
                FROM "threads" WHERE "role" = 'master_review'
            ),
            ins_stages AS (
                INSERT INTO "stages" ("id", "job_id", "org_id", "ordinal", "kind", "status", "condition", "decision_record_id", "config")
                SELECT stage_id, "job_id", "org_id", "ordinal", 'master_review', 'pending', 'none', "decision_record_id", "config"
                FROM mr
            )
            UPDATE "threads" t SET "stage_id" = mr.stage_id FROM mr WHERE t."id" = mr.thread_id
        `);

        // ── Step 4: remap role values + safety-net any thread still lacking a stage ───────────
        await queryRunner.query(`UPDATE "threads" SET "role" = 'review_agent' WHERE "role" = 'review_lens'`);
        await queryRunner.query(`UPDATE "threads" SET "role" = 'review_fix' WHERE "role" = 'post_review'`);
        // 'main' → 'planning' already handled in 3a; 'builder' / 'plan_review' / 'master_review' unchanged.
        // Defensive: any thread whose stage_id is somehow still null (e.g. an orphaned review child with
        // no builder parent) falls back to its job's planning stage so the NOT NULL enforce below holds.
        await queryRunner.query(`
            UPDATE "threads" t SET "stage_id" = s."id"
            FROM "stages" s
            WHERE t."stage_id" IS NULL AND s."kind" = 'planning' AND s."job_id" = t."job_id"
        `);

        // ── Step 5: backfill threads.session_id / commit_sha ─────────────────────────────────
        // Build threads: from their anchor steps row. A builder thread commonly has MANY steps rows
        // (one per plan step, further diverging across leg rotations) — `UPDATE ... FROM` with a
        // multi-row match picks an unspecified one, so pick the anchor deterministically: the
        // highest-ordinal row that actually carries a value, mirroring driver-store.service.ts's
        // `resolveSessionAnchor` (walks steps in reverse ordinal order for the latest non-null hit).
        // session_id and commit_sha are resolved independently since their most-recent-non-null rows
        // can differ.
        await queryRunner.query(`
            UPDATE "threads" t SET "session_id" = anchor.session_id
            FROM (
                SELECT DISTINCT ON (s."thread_id") s."thread_id", s."session_id"
                FROM "steps" s
                WHERE s."session_id" IS NOT NULL
                ORDER BY s."thread_id", s."ordinal" DESC
            ) anchor
            WHERE anchor."thread_id" = t."id" AND t."role" = 'builder'
        `);
        await queryRunner.query(`
            UPDATE "threads" t SET "commit_sha" = anchor.commit_sha
            FROM (
                SELECT DISTINCT ON (s."thread_id") s."thread_id", s."commit_sha"
                FROM "steps" s
                WHERE s."commit_sha" IS NOT NULL
                ORDER BY s."thread_id", s."ordinal" DESC
            ) anchor
            WHERE anchor."thread_id" = t."id" AND t."role" = 'builder'
        `);
        // Planning thread: resume session from the job sandbox.
        await queryRunner.query(`
            UPDATE "threads" t SET "session_id" = js."session_id"
            FROM "job_sandboxes" js
            WHERE js."job_id" = t."job_id" AND t."role" = 'planning'
        `);
        // Carry the sandbox's compaction seeds onto the planning thread's config (only when non-null).
        await queryRunner.query(`
            UPDATE "threads" t SET "config" = t."config" || jsonb_strip_nulls(jsonb_build_object(
                'pendingCompactionSeed', js."pending_compaction_seed",
                'compactingSessionId', js."compacting_session_id"
            ))
            FROM "job_sandboxes" js
            WHERE js."job_id" = t."job_id" AND t."role" = 'planning'
        `);

        // ── Step 6: backfill tasks — explode both old task blobs into rows ───────────────────
        // Both blobs are merged into ONE ranked source set so, when several independent source lists
        // land on the SAME stage (a builder thread's own tasks + its review children's tasks, or a
        // planning thread's tasks + the job's main_tasks), each source gets its own gap-numbered
        // ordinal BLOCK instead of every list restarting at ordinal 10 and colliding. A temp mapping
        // table also carries each element's OLD TaskItem id (scoped to its own source list) alongside
        // the freshly generated row id, so `blockedBy` dependency edges can be rewritten from old ids
        // to the new row ids in a second pass — they never point outside their own source list.
        await queryRunner.query(`
            CREATE TEMP TABLE "_task_backfill_map" AS
            WITH src AS (
                SELECT t."stage_id" AS stage_id, t."org_id" AS org_id, t."id" AS source_id,
                       t."ordinal" AS source_rank_key, elem.value AS value, elem.idx AS idx
                FROM "threads" t
                CROSS JOIN LATERAL jsonb_array_elements(t."tasks") WITH ORDINALITY AS elem(value, idx)
                WHERE jsonb_typeof(t."tasks") = 'array' AND jsonb_array_length(t."tasks") > 0
                UNION ALL
                SELECT s."id" AS stage_id, j."org_id" AS org_id, j."id" AS source_id,
                       -1 AS source_rank_key, elem.value AS value, elem.idx AS idx
                FROM "jobs" j
                JOIN "stages" s ON s."job_id" = j."id" AND s."kind" = 'planning'
                CROSS JOIN LATERAL jsonb_array_elements(j."main_tasks") WITH ORDINALITY AS elem(value, idx)
                WHERE jsonb_typeof(j."main_tasks") = 'array' AND jsonb_array_length(j."main_tasks") > 0
            )
            SELECT src.*, (src.value->>'id') AS old_id, uuid_generate_v4() AS new_id,
                   DENSE_RANK() OVER (PARTITION BY stage_id ORDER BY source_rank_key, source_id) AS source_rank
            FROM src
        `);
        await queryRunner.query(`
            INSERT INTO "tasks" ("id", "stage_id", "org_id", "ordinal", "title", "brief", "active_form", "status")
            SELECT new_id, stage_id, org_id, ((source_rank - 1) * 1000 + idx * 10)::int,
                   COALESCE(value->>'subject', ''),
                   value->>'description',
                   value->>'activeForm',
                   COALESCE(value->>'status', 'pending')
            FROM "_task_backfill_map"
        `);
        // blockedBy: rewrite each element's old (source-scoped) TaskItem id to the new task row id; an
        // id that doesn't resolve within the same source list (unknown/dangling target) is dropped
        // rather than left pointing at nothing.
        await queryRunner.query(`
            UPDATE "tasks" t SET "blocked_by" = COALESCE(remap.new_ids, '[]'::jsonb)
            FROM "_task_backfill_map" m
            LEFT JOIN LATERAL (
                SELECT jsonb_agg(m2."new_id") AS new_ids
                FROM jsonb_array_elements_text(COALESCE(m."value"->'blockedBy', '[]'::jsonb)) AS old_ref(old_id)
                JOIN "_task_backfill_map" m2 ON m2."source_id" = m."source_id" AND m2."old_id" = old_ref.old_id
            ) remap ON true
            WHERE t."id" = m."new_id"
        `);
        await queryRunner.query(`DROP TABLE "_task_backfill_map"`);

        // ── Step 7: backfill messages.thread_id ──────────────────────────────────────────────
        // Primary: a phase block carries the owning step's id in meta.phaseId. Compare against the
        // step id as text so a non-uuid meta value can never raise a cast error.
        await queryRunner.query(`
            UPDATE "messages" m SET "thread_id" = s."thread_id"
            FROM "steps" s
            WHERE (m."meta"->>'phaseId') IS NOT NULL AND (m."meta"->>'phaseId') = s."id"::text
        `);
        // Fallback: everything else lands on the job's planning thread.
        await queryRunner.query(`
            UPDATE "messages" m SET "thread_id" = t."id"
            FROM "threads" t
            WHERE m."thread_id" IS NULL AND t."job_id" = m."job_id" AND t."role" = 'planning'
        `);

        // ── Step 8: backfill subagents + messages.subagent_id ────────────────────────────────
        // One subagent per Task launching block.
        await queryRunner.query(`
            INSERT INTO "subagents" ("id", "thread_id", "parent_message_id", "tool_use_id", "agent_type", "model", "status")
            SELECT uuid_generate_v4(), m."thread_id", m."id", m."meta"->>'id',
                   m."meta"->'input'->>'subagent_type', NULL,
                   CASE WHEN m."meta"->>'result' IS NOT NULL THEN 'done' ELSE 'running' END
            FROM "messages" m
            WHERE m."kind" = 'tool' AND m."meta"->>'name' = 'Task' AND (m."meta"->>'id') IS NOT NULL
        `);
        // Link each subagent's child transcript blocks (scoped by thread — tool_use_id is only
        // guaranteed unique within one thread's turn stream).
        await queryRunner.query(`
            UPDATE "messages" c SET "subagent_id" = sub."id"
            FROM "subagents" sub
            WHERE c."meta"->>'parentToolUseId' = sub."tool_use_id" AND c."thread_id" = sub."thread_id"
        `);

        // ── Step 9: repoint phase identity (must run while `steps` still exists) ─────────────
        await queryRunner.query(`
            UPDATE "turn_stats" ts SET "thread_id" = s."thread_id"
            FROM "steps" s
            WHERE ts."step_id" = s."id" AND ts."thread_id" IS NULL
        `);
        // Rewrite meta.phaseId in place from the old step-id to the owning thread-id.
        await queryRunner.query(`
            UPDATE "messages" SET "meta" = jsonb_set("meta", '{phaseId}', to_jsonb("thread_id"::text), true)
            WHERE "meta" ? 'phaseId' AND "thread_id" IS NOT NULL
        `);

        // ── Step 10: enforce NOT NULL ────────────────────────────────────────────────────────
        await queryRunner.query(`ALTER TABLE "threads" ALTER COLUMN "stage_id" SET NOT NULL`);
        await queryRunner.query(`ALTER TABLE "messages" ALTER COLUMN "thread_id" SET NOT NULL`);

        // ── Step 11: drop the retired tables + columns ───────────────────────────────────────
        await queryRunner.query(`DROP TABLE "build_legs"`);
        await queryRunner.query(`DROP TABLE "steps"`);
        await queryRunner.query(`DROP TABLE "codex_reviews"`);

        // threads.decision_record_id moved to stages (d7). Its own FK/index go first; the composite
        // unique index that referenced it is recreated WITHOUT it (now (job_id, parent_thread_id,
        // ordinal) NULLS NOT DISTINCT — see ThreadEntity), keeping the same name.
        await queryRunner.query(`DROP INDEX "public"."uq_threads_job_parent_ordinal"`);
        await queryRunner.query(`ALTER TABLE "threads" DROP CONSTRAINT "fk_threads_decision_record_id_decision_records"`);
        await queryRunner.query(`DROP INDEX "public"."idx_threads_decision_record_id"`);
        await queryRunner.query(`ALTER TABLE "threads" DROP COLUMN "decision_record_id"`);
        await queryRunner.query(`ALTER TABLE "threads" DROP COLUMN "tasks"`);
        await queryRunner.query(`CREATE UNIQUE INDEX "uq_threads_job_parent_ordinal" ON "threads" ("job_id", "parent_thread_id", "ordinal") NULLS NOT DISTINCT`);

        await queryRunner.query(`ALTER TABLE "jobs" DROP COLUMN "main_tasks"`);
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        // Best-effort STRUCTURAL reverse: restore the shape, not the data.
        // messages — drop the new FKs/index/columns.
        await queryRunner.query(`ALTER TABLE "messages" DROP CONSTRAINT "fk_messages_subagent_id_subagents"`);
        await queryRunner.query(`ALTER TABLE "messages" DROP CONSTRAINT "fk_messages_thread_id_threads"`);
        await queryRunner.query(`DROP INDEX "public"."idx_messages_thread_id_created_at"`);
        await queryRunner.query(`DROP INDEX "public"."idx_messages_subagent_id"`);
        await queryRunner.query(`ALTER TABLE "messages" DROP COLUMN "subagent_id"`);
        await queryRunner.query(`ALTER TABLE "messages" DROP COLUMN "thread_id"`);

        // Drop the new tables (subagents refs threads/messages; tasks refs stages).
        await queryRunner.query(`DROP TABLE "subagents"`);
        await queryRunner.query(`DROP TABLE "tasks"`);

        // threads — reverse the ALTERs, then drop stages (threads/tasks FKs to it are gone by now).
        await queryRunner.query(`DROP INDEX "public"."uq_threads_job_parent_ordinal"`);
        await queryRunner.query(`ALTER TABLE "threads" DROP CONSTRAINT "fk_threads_stage_id_stages"`);
        await queryRunner.query(`DROP INDEX "public"."idx_threads_stage_id"`);
        await queryRunner.query(`ALTER TABLE "threads" DROP COLUMN "stage_id"`);
        await queryRunner.query(`ALTER TABLE "threads" DROP COLUMN "session_id"`);
        await queryRunner.query(`ALTER TABLE "threads" DROP COLUMN "commit_sha"`);
        await queryRunner.query(`ALTER TABLE "threads" RENAME COLUMN "role" TO "kind"`);
        await queryRunner.query(`ALTER TABLE "threads" ADD "tasks" jsonb NOT NULL DEFAULT '[]'`);
        await queryRunner.query(`ALTER TABLE "threads" ADD "decision_record_id" uuid`);
        await queryRunner.query(`CREATE INDEX "idx_threads_decision_record_id" ON "threads" ("decision_record_id") `);
        await queryRunner.query(`ALTER TABLE "threads" ADD CONSTRAINT "fk_threads_decision_record_id_decision_records" FOREIGN KEY ("decision_record_id") REFERENCES "decision_records"("id") ON DELETE CASCADE ON UPDATE NO ACTION`);
        await queryRunner.query(`CREATE UNIQUE INDEX "uq_threads_job_parent_ordinal" ON "threads" ("job_id", "decision_record_id", "parent_thread_id", "ordinal") NULLS NOT DISTINCT`);

        await queryRunner.query(`DROP TABLE "stages"`);

        // jobs — restore main_tasks.
        await queryRunner.query(`ALTER TABLE "jobs" ADD "main_tasks" jsonb NOT NULL DEFAULT '[]'`);

        // Recreate the three dropped tables EMPTY (correct shape, no data restore).
        await queryRunner.query(`CREATE TABLE "steps" ("created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), "updated_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), "id" uuid NOT NULL DEFAULT uuid_generate_v4(), "thread_id" uuid NOT NULL, "job_id" uuid NOT NULL, "org_id" uuid NOT NULL, "ordinal" integer NOT NULL, "title" text, "brief" text NOT NULL, "stage" text NOT NULL DEFAULT 'build', "status" text NOT NULL DEFAULT 'pending', "session_id" text, "batch_ordinal" integer, "commit_sha" text, "rotating_session_id" text, "pending_leg_seed" text, "leg_ordinal" integer NOT NULL DEFAULT '1', CONSTRAINT "uq_steps_thread_id_ordinal" UNIQUE ("thread_id", "ordinal"), CONSTRAINT "pk_steps" PRIMARY KEY ("id"))`);
        await queryRunner.query(`CREATE INDEX "idx_steps_job_id" ON "steps" ("job_id") `);
        await queryRunner.query(`CREATE INDEX "idx_steps_thread_id" ON "steps" ("thread_id") `);
        await queryRunner.query(`ALTER TABLE "steps" ADD CONSTRAINT "fk_steps_thread_id_threads" FOREIGN KEY ("thread_id") REFERENCES "threads"("id") ON DELETE CASCADE ON UPDATE NO ACTION`);
        await queryRunner.query(`ALTER TABLE "steps" ADD CONSTRAINT "fk_steps_job_id_jobs" FOREIGN KEY ("job_id") REFERENCES "jobs"("id") ON DELETE CASCADE ON UPDATE NO ACTION`);
        await queryRunner.query(`ALTER TABLE "steps" ADD CONSTRAINT "fk_steps_org_id_organizations" FOREIGN KEY ("org_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE NO ACTION`);

        await queryRunner.query(`CREATE TABLE "build_legs" ("created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), "updated_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), "id" uuid NOT NULL DEFAULT uuid_generate_v4(), "org_id" uuid NOT NULL, "job_id" uuid NOT NULL, "thread_id" uuid NOT NULL, "ordinal" integer NOT NULL, "session_id" text, "status" text NOT NULL DEFAULT 'active', "handoff_md" text, "context_tokens_peak" integer, "ended_at" TIMESTAMP WITH TIME ZONE, CONSTRAINT "uq_build_legs_thread_id_ordinal" UNIQUE ("thread_id", "ordinal"), CONSTRAINT "pk_build_legs" PRIMARY KEY ("id"))`);
        await queryRunner.query(`CREATE INDEX "idx_build_legs_job_id" ON "build_legs" ("job_id") `);
        await queryRunner.query(`CREATE INDEX "idx_build_legs_thread_id" ON "build_legs" ("thread_id") `);
        await queryRunner.query(`ALTER TABLE "build_legs" ADD CONSTRAINT "fk_build_legs_thread_id_threads" FOREIGN KEY ("thread_id") REFERENCES "threads"("id") ON DELETE CASCADE ON UPDATE NO ACTION`);
        await queryRunner.query(`ALTER TABLE "build_legs" ADD CONSTRAINT "fk_build_legs_job_id_jobs" FOREIGN KEY ("job_id") REFERENCES "jobs"("id") ON DELETE CASCADE ON UPDATE NO ACTION`);
        await queryRunner.query(`ALTER TABLE "build_legs" ADD CONSTRAINT "fk_build_legs_org_id_organizations" FOREIGN KEY ("org_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE NO ACTION`);

        await queryRunner.query(`CREATE TABLE "codex_reviews" ("created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), "updated_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), "id" uuid NOT NULL DEFAULT uuid_generate_v4(), "job_id" uuid NOT NULL, "org_id" uuid NOT NULL, "codex_session_id" text, "spec_hash" text, "status" text NOT NULL DEFAULT 'running', "findings" text, "error" text, "resume_count" integer NOT NULL DEFAULT '0', CONSTRAINT "pk_codex_reviews" PRIMARY KEY ("id"))`);
        await queryRunner.query(`CREATE INDEX "idx_codex_reviews_status" ON "codex_reviews" ("status") `);
        await queryRunner.query(`CREATE INDEX "idx_codex_reviews_job_id" ON "codex_reviews" ("job_id") `);
        await queryRunner.query(`ALTER TABLE "codex_reviews" ADD CONSTRAINT "fk_codex_reviews_job_id_jobs" FOREIGN KEY ("job_id") REFERENCES "jobs"("id") ON DELETE CASCADE ON UPDATE NO ACTION`);
    }

}
