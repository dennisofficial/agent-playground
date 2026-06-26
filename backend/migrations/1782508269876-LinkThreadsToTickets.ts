import { MigrationInterface, QueryRunner } from "typeorm";

export class LinkThreadsToTickets1782508269876 implements MigrationInterface {
    name = 'LinkThreadsToTickets1782508269876'

    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`ALTER TABLE "threads" ADD "ticket_id" uuid`);
        await queryRunner.query(`ALTER TABLE "threads" ADD CONSTRAINT "fk_threads_ticket_id_tickets" FOREIGN KEY ("ticket_id") REFERENCES "tickets"("id") ON DELETE SET NULL ON UPDATE NO ACTION`);
        // Enforce the thread↔ticket 1:1 (a ticket has AT MOST one thread). A plain @ManyToOne does not —
        // hand-add a PARTIAL unique index so multiple NULLs (unlinked threads) are still allowed.
        await queryRunner.query(`CREATE UNIQUE INDEX "uq_threads_ticket_id" ON "threads" ("ticket_id") WHERE "ticket_id" IS NOT NULL`);
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`DROP INDEX "public"."uq_threads_ticket_id"`);
        await queryRunner.query(`ALTER TABLE "threads" DROP CONSTRAINT "fk_threads_ticket_id_tickets"`);
        await queryRunner.query(`ALTER TABLE "threads" DROP COLUMN "ticket_id"`);
    }

}
