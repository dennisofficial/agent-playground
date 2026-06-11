import { MigrationInterface, QueryRunner } from "typeorm";

export class AddSlackBotUserId1781205417466 implements MigrationInterface {
    name = 'AddSlackBotUserId1781205417466'

    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`ALTER TABLE "slack_identities" ADD "slack_bot_user_id" text`);
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`ALTER TABLE "slack_identities" DROP COLUMN "slack_bot_user_id"`);
    }

}
