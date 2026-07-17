import { MigrationInterface, QueryRunner } from "typeorm";

export class AddTranscriptOrderAt1784251143250 implements MigrationInterface {
    name = 'AddTranscriptOrderAt1784251143250'

    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`ALTER TABLE "transcript_messages" ADD "order_at" TIMESTAMP WITH TIME ZONE`);
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`ALTER TABLE "transcript_messages" DROP COLUMN "order_at"`);
    }

}
