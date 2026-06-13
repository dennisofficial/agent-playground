import { MigrationInterface, QueryRunner } from "typeorm";

export class AddAdminUsers1781322080744 implements MigrationInterface {
    name = 'AddAdminUsers1781322080744'

    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`CREATE TABLE "admin_users" ("created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), "updated_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), "id" uuid NOT NULL, "email" text NOT NULL, "password_hash" text NOT NULL, "name" text, "role" text NOT NULL DEFAULT 'admin', CONSTRAINT "pk_admin_users" PRIMARY KEY ("id"))`);
        await queryRunner.query(`CREATE UNIQUE INDEX "idx_admin_users_email" ON "admin_users" ("email") `);
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`DROP INDEX "public"."idx_admin_users_email"`);
        await queryRunner.query(`DROP TABLE "admin_users"`);
    }

}
