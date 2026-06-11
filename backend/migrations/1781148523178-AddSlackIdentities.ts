import { MigrationInterface, QueryRunner } from "typeorm";

export class AddSlackIdentities1781148523178 implements MigrationInterface {
    name = 'AddSlackIdentities1781148523178'

    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`CREATE TABLE "slack_identities" ("created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), "updated_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), "bot_id" text NOT NULL, "token_ciphertext" text NOT NULL, CONSTRAINT "pk_slack_identities" PRIMARY KEY ("bot_id"))`);
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`DROP TABLE "slack_identities"`);
    }

}
