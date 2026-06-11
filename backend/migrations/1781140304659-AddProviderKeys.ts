import { MigrationInterface, QueryRunner } from "typeorm";

export class AddProviderKeys1781140304659 implements MigrationInterface {
    name = 'AddProviderKeys1781140304659'

    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`CREATE TABLE "provider_keys" ("created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), "updated_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), "provider" text NOT NULL, "key_ciphertext" text NOT NULL, CONSTRAINT "pk_provider_keys" PRIMARY KEY ("provider"))`);
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`DROP TABLE "provider_keys"`);
    }

}
