import { MigrationInterface, QueryRunner } from "typeorm";

export class InitControlSchema1781141530681 implements MigrationInterface {
    name = 'InitControlSchema1781141530681'

    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`CREATE TABLE "tenants" ("created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), "updated_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), "team_id" text NOT NULL, "team_name" text NOT NULL, "status" text NOT NULL DEFAULT 'provisioning', "bot_token_ciphertext" text NOT NULL, "stack_base_url" text, "installed_by" text, CONSTRAINT "pk_tenants" PRIMARY KEY ("team_id"))`);
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`DROP TABLE "tenants"`);
    }

}
