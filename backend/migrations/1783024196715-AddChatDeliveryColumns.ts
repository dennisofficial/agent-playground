import { MigrationInterface, QueryRunner } from "typeorm";

export class AddChatDeliveryColumns1783024196715 implements MigrationInterface {
    name = 'AddChatDeliveryColumns1783024196715'

    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`ALTER TABLE "stimuli" ADD "author_name" text`);
        await queryRunner.query(`ALTER TABLE "stimuli" ADD "attempted_at" TIMESTAMP WITH TIME ZONE`);
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`ALTER TABLE "stimuli" DROP COLUMN "attempted_at"`);
        await queryRunner.query(`ALTER TABLE "stimuli" DROP COLUMN "author_name"`);
    }

}
