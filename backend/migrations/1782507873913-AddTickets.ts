import { MigrationInterface, QueryRunner } from 'typeorm';

export class AddTickets1782507873913 implements MigrationInterface {
  name = 'AddTickets1782507873913';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `CREATE TABLE "tickets" ("created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), "updated_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), "id" uuid NOT NULL DEFAULT uuid_generate_v4(), "org_id" uuid NOT NULL, "repo_id" uuid NOT NULL, "number" integer NOT NULL, "title" text NOT NULL, "body" text, "status" text NOT NULL DEFAULT 'backlog', "priority" text, "kind" text, "sort_order" double precision NOT NULL DEFAULT '0', "origin_thread_id" uuid, "origin_decision_record_id" uuid, "origin" jsonb, CONSTRAINT "uq_tickets_repo_id_number" UNIQUE ("repo_id", "number"), CONSTRAINT "pk_tickets" PRIMARY KEY ("id"))`,
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
      `ALTER TABLE "tickets" ADD CONSTRAINT "fk_tickets_origin_thread_id_threads" FOREIGN KEY ("origin_thread_id") REFERENCES "threads"("id") ON DELETE SET NULL ON UPDATE NO ACTION`,
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
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "ticket_counters" DROP CONSTRAINT "fk_ticket_counters_repo_id_repos"`,
    );
    await queryRunner.query(
      `ALTER TABLE "ticket_dependencies" DROP CONSTRAINT "fk_ticket_dependencies_depends_on_ticket_id_tickets"`,
    );
    await queryRunner.query(
      `ALTER TABLE "ticket_dependencies" DROP CONSTRAINT "fk_ticket_dependencies_ticket_id_tickets"`,
    );
    await queryRunner.query(
      `ALTER TABLE "ticket_dependencies" DROP CONSTRAINT "fk_ticket_dependencies_repo_id_repos"`,
    );
    await queryRunner.query(
      `ALTER TABLE "ticket_dependencies" DROP CONSTRAINT "fk_ticket_dependencies_org_id_organizations"`,
    );
    await queryRunner.query(
      `ALTER TABLE "tickets" DROP CONSTRAINT "fk_tickets_origin_decision_record_id_decision_records"`,
    );
    await queryRunner.query(
      `ALTER TABLE "tickets" DROP CONSTRAINT "fk_tickets_origin_thread_id_threads"`,
    );
    await queryRunner.query(`ALTER TABLE "tickets" DROP CONSTRAINT "fk_tickets_repo_id_repos"`);
    await queryRunner.query(
      `ALTER TABLE "tickets" DROP CONSTRAINT "fk_tickets_org_id_organizations"`,
    );
    await queryRunner.query(`DROP TABLE "ticket_counters"`);
    await queryRunner.query(`DROP INDEX "public"."idx_ticket_dependencies_org_id_repo_id"`);
    await queryRunner.query(`DROP INDEX "public"."idx_ticket_dependencies_depends_on_ticket_id"`);
    await queryRunner.query(`DROP TABLE "ticket_dependencies"`);
    await queryRunner.query(`DROP INDEX "public"."idx_tickets_org_id_repo_id"`);
    await queryRunner.query(`DROP TABLE "tickets"`);
  }
}
