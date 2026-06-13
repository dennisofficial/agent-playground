import { MigrationInterface, QueryRunner } from "typeorm";

export class AddCompactionSummaries1781500000000 implements MigrationInterface {
    name = 'AddCompactionSummaries1781500000000'

    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`CREATE TABLE "compaction_summaries" ("id" SERIAL NOT NULL, "thread" text NOT NULL, "version" integer NOT NULL, "covered_up_to" integer NOT NULL, "summary" text NOT NULL, "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), "updated_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), CONSTRAINT "pk_compaction_summaries" PRIMARY KEY ("id"))`);
        await queryRunner.query(`CREATE INDEX "idx_compaction_summaries_thread" ON "compaction_summaries" ("thread") `);
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`DROP INDEX "public"."idx_compaction_summaries_thread"`);
        await queryRunner.query(`DROP TABLE "compaction_summaries"`);
    }

}
