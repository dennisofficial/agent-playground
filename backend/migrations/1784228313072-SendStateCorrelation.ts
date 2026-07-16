import { MigrationInterface, QueryRunner } from "typeorm";

export class SendStateCorrelation1784228313072 implements MigrationInterface {
    name = 'SendStateCorrelation1784228313072'

    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`ALTER TABLE "transcript_messages" ADD "stimulus_id" uuid`);
        await queryRunner.query(`ALTER TABLE "transcript_messages" ADD "delivered_at" TIMESTAMP WITH TIME ZONE`);
        await queryRunner.query(`CREATE INDEX "idx_transcript_messages_stimulus_id" ON "transcript_messages" ("stimulus_id") `);
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`DROP INDEX "public"."idx_transcript_messages_stimulus_id"`);
        await queryRunner.query(`ALTER TABLE "transcript_messages" DROP COLUMN "delivered_at"`);
        await queryRunner.query(`ALTER TABLE "transcript_messages" DROP COLUMN "stimulus_id"`);
    }

}
