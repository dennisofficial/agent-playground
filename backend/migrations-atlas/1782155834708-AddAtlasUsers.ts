import { MigrationInterface, QueryRunner } from "typeorm";

export class AddAtlasUsers1782155834708 implements MigrationInterface {
    name = 'AddAtlasUsers1782155834708'

    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`CREATE TABLE "atlas_users" ("created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), "updated_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), "id" uuid NOT NULL DEFAULT uuid_generate_v4(), "email" text NOT NULL, "password_hash" text NOT NULL, "role" text NOT NULL DEFAULT 'operator', "is_approved" boolean NOT NULL DEFAULT false, CONSTRAINT "pk_atlas_users" PRIMARY KEY ("id"))`);
        await queryRunner.query(`CREATE UNIQUE INDEX "idx_atlas_users_email" ON "atlas_users" ("email") `);
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`DROP INDEX "public"."idx_atlas_users_email"`);
        await queryRunner.query(`DROP TABLE "atlas_users"`);
    }

}
