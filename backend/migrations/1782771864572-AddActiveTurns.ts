import { MigrationInterface, QueryRunner } from 'typeorm';

export class AddActiveTurns1782771864572 implements MigrationInterface {
  name = 'AddActiveTurns1782771864572';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `CREATE TABLE "active_turns" ("created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), "updated_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), "turn_id" uuid NOT NULL, "thread_id" uuid NOT NULL, "org_id" uuid NOT NULL, "channel" text NOT NULL, "lane" text NOT NULL DEFAULT 'main', "kind" text NOT NULL, "container_id" text, "status" text NOT NULL DEFAULT 'running', "events_last_id" text NOT NULL DEFAULT '0-0', "last_heartbeat_at" TIMESTAMP WITH TIME ZONE, "ctx" jsonb NOT NULL DEFAULT '{}'::jsonb, CONSTRAINT "pk_active_turns" PRIMARY KEY ("turn_id"))`,
    );
    await queryRunner.query(
      `CREATE INDEX "idx_active_turns_thread_id" ON "active_turns" ("thread_id") `,
    );
    await queryRunner.query(
      `CREATE INDEX "idx_active_turns_status" ON "active_turns" ("status") `,
    );
    await queryRunner.query(
      `ALTER TABLE "active_turns" ADD CONSTRAINT "fk_active_turns_thread_id_threads" FOREIGN KEY ("thread_id") REFERENCES "threads"("id") ON DELETE CASCADE ON UPDATE NO ACTION`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "active_turns" DROP CONSTRAINT "fk_active_turns_thread_id_threads"`,
    );
    await queryRunner.query(`DROP INDEX "public"."idx_active_turns_status"`);
    await queryRunner.query(`DROP INDEX "public"."idx_active_turns_thread_id"`);
    await queryRunner.query(`DROP TABLE "active_turns"`);
  }
}
