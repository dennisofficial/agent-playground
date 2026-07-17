import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Hard-drop the native ticket system (board/backlog): the `tickets`, `ticket_dependencies`, and
 * `ticket_counters` tables plus the `jobs.ticket_id` linkage and its `uq_threads_ticket_id` partial
 * unique index. Operator-confirmed destructive removal — existing ticket rows are permanently deleted
 * with no export. Also makes ticket #9 (`uq_threads_ticket_id` drift) moot.
 *
 * Hand-written (NOT `migration:generate`): the surgical drop below is what we want, whereas the
 * generator would also try to re-drop unrelated schema drift.
 */
export class DropTickets1784000000000 implements MigrationInterface {
  name = 'DropTickets1784000000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    // 1. Sever the jobs → tickets link first (index, FK, then column).
    await queryRunner.query(`DROP INDEX IF EXISTS "public"."uq_threads_ticket_id"`);
    await queryRunner.query(
      `ALTER TABLE "jobs" DROP CONSTRAINT IF EXISTS "fk_jobs_ticket_id_tickets"`,
    );
    await queryRunner.query(`ALTER TABLE "jobs" DROP COLUMN IF EXISTS "ticket_id"`);
    // 2. Drop the ticket tables. CASCADE cleans dependent FKs/indexes (incl. idx_tickets_embedding_hnsw).
    await queryRunner.query(`DROP TABLE IF EXISTS "ticket_dependencies" CASCADE`);
    await queryRunner.query(`DROP TABLE IF EXISTS "ticket_counters" CASCADE`);
    await queryRunner.query(`DROP TABLE IF EXISTS "tickets" CASCADE`);
  }

  // Best-effort STRUCTURE-ONLY restore. The dropped row data is permanently unrecoverable by design
  // (decision d1) — this reconstructs the empty schema only, so a revert leaves usable tables but no
  // tickets. Reconstructed from the original AddTickets/AddTicketEmbedding/LinkThreadsToTickets bodies,
  // adapted to the post-rename `jobs`/`origin_job_id` names.
  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `CREATE TABLE "tickets" ("created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), "updated_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), "id" uuid NOT NULL DEFAULT uuid_generate_v4(), "org_id" uuid NOT NULL, "repo_id" uuid NOT NULL, "number" integer NOT NULL, "title" text NOT NULL, "body" text, "status" text NOT NULL DEFAULT 'backlog', "priority" text, "kind" text, "sort_order" double precision NOT NULL DEFAULT '0', "origin_job_id" uuid, "origin_decision_record_id" uuid, "origin" jsonb, CONSTRAINT "uq_tickets_repo_id_number" UNIQUE ("repo_id", "number"), CONSTRAINT "pk_tickets" PRIMARY KEY ("id"))`,
    );
    await queryRunner.query(
      `CREATE INDEX "idx_tickets_org_id_repo_id" ON "tickets" ("org_id", "repo_id") `,
    );
    await queryRunner.query(
      `CREATE TABLE "ticket_dependencies" ("created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), "updated_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), "id" uuid NOT NULL DEFAULT uuid_generate_v4(), "org_id" uuid NOT NULL, "repo_id" uuid NOT NULL, "ticket_id" uuid NOT NULL, "depends_on_ticket_id" uuid NOT NULL, CONSTRAINT "uq_ticket_dependencies_ticket_id_depends_on_ticket_id" UNIQUE ("ticket_id", "depends_on_ticket_id"), CONSTRAINT "pk_ticket_dependencies" PRIMARY KEY ("id"))`,
    );
    await queryRunner.query(
      `CREATE INDEX "idx_ticket_dependencies_depends_on_ticket_id" ON "ticket_dependencies" ("depends_on_ticket_id") `,
    );
    await queryRunner.query(
      `CREATE INDEX "idx_ticket_dependencies_org_id_repo_id" ON "ticket_dependencies" ("org_id", "repo_id") `,
    );
    await queryRunner.query(
      `CREATE TABLE "ticket_counters" ("repo_id" uuid NOT NULL, "next" integer NOT NULL DEFAULT '0', CONSTRAINT "pk_ticket_counters" PRIMARY KEY ("repo_id"))`,
    );
    await queryRunner.query(
      `ALTER TABLE "tickets" ADD CONSTRAINT "fk_tickets_org_id_organizations" FOREIGN KEY ("org_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE NO ACTION`,
    );
    await queryRunner.query(
      `ALTER TABLE "tickets" ADD CONSTRAINT "fk_tickets_repo_id_repos" FOREIGN KEY ("repo_id") REFERENCES "repos"("id") ON DELETE CASCADE ON UPDATE NO ACTION`,
    );
    await queryRunner.query(
      `ALTER TABLE "tickets" ADD CONSTRAINT "fk_tickets_origin_job_id_jobs" FOREIGN KEY ("origin_job_id") REFERENCES "jobs"("id") ON DELETE SET NULL ON UPDATE NO ACTION`,
    );
    await queryRunner.query(
      `ALTER TABLE "tickets" ADD CONSTRAINT "fk_tickets_origin_decision_record_id_decision_records" FOREIGN KEY ("origin_decision_record_id") REFERENCES "decision_records"("id") ON DELETE SET NULL ON UPDATE NO ACTION`,
    );
    await queryRunner.query(
      `ALTER TABLE "ticket_dependencies" ADD CONSTRAINT "fk_ticket_dependencies_org_id_organizations" FOREIGN KEY ("org_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE NO ACTION`,
    );
    await queryRunner.query(
      `ALTER TABLE "ticket_dependencies" ADD CONSTRAINT "fk_ticket_dependencies_repo_id_repos" FOREIGN KEY ("repo_id") REFERENCES "repos"("id") ON DELETE CASCADE ON UPDATE NO ACTION`,
    );
    await queryRunner.query(
      `ALTER TABLE "ticket_dependencies" ADD CONSTRAINT "fk_ticket_dependencies_ticket_id_tickets" FOREIGN KEY ("ticket_id") REFERENCES "tickets"("id") ON DELETE CASCADE ON UPDATE NO ACTION`,
    );
    await queryRunner.query(
      `ALTER TABLE "ticket_dependencies" ADD CONSTRAINT "fk_ticket_dependencies_depends_on_ticket_id_tickets" FOREIGN KEY ("depends_on_ticket_id") REFERENCES "tickets"("id") ON DELETE CASCADE ON UPDATE NO ACTION`,
    );
    await queryRunner.query(
      `ALTER TABLE "ticket_counters" ADD CONSTRAINT "fk_ticket_counters_repo_id_repos" FOREIGN KEY ("repo_id") REFERENCES "repos"("id") ON DELETE CASCADE ON UPDATE NO ACTION`,
    );
    // AddTicketEmbedding: 1536-dim vector + pgvector HNSW cosine index.
    await queryRunner.query(`ALTER TABLE "tickets" ADD "embedding" vector(1536)`);
    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS "idx_tickets_embedding_hnsw" ON "tickets" USING hnsw ("embedding" vector_cosine_ops)`,
    );
    // LinkThreadsToTickets (adapted to the renamed `jobs` table): jobs.ticket_id + FK + partial unique index.
    await queryRunner.query(`ALTER TABLE "jobs" ADD "ticket_id" uuid`);
    await queryRunner.query(
      `ALTER TABLE "jobs" ADD CONSTRAINT "fk_jobs_ticket_id_tickets" FOREIGN KEY ("ticket_id") REFERENCES "tickets"("id") ON DELETE SET NULL ON UPDATE NO ACTION`,
    );
    await queryRunner.query(
      `CREATE UNIQUE INDEX "uq_threads_ticket_id" ON "jobs" ("ticket_id") WHERE "ticket_id" IS NOT NULL`,
    );
  }
}
