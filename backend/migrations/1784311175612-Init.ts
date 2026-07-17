import { MigrationInterface, QueryRunner } from "typeorm";

export class Init1784311175612 implements MigrationInterface {
    name = 'Init1784311175612'

    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`CREATE TYPE "public"."organizations_status_enum" AS ENUM('onboarding', 'active', 'suspended')`);
        await queryRunner.query(`CREATE TABLE "organizations" ("created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), "updated_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), "id" uuid NOT NULL DEFAULT uuid_generate_v4(), "name" text NOT NULL, "status" "public"."organizations_status_enum" NOT NULL DEFAULT 'onboarding', "default_auto_approve" boolean NOT NULL DEFAULT false, "default_auto_ship" boolean NOT NULL DEFAULT false, "default_auto_merge" boolean NOT NULL DEFAULT false, CONSTRAINT "pk_organizations" PRIMARY KEY ("id"))`);
        await queryRunner.query(`CREATE TYPE "public"."users_role_enum" AS ENUM('admin', 'operator')`);
        await queryRunner.query(`CREATE TYPE "public"."users_status_enum" AS ENUM('pending', 'active', 'suspended')`);
        await queryRunner.query(`CREATE TABLE "users" ("created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), "updated_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), "id" uuid NOT NULL DEFAULT uuid_generate_v4(), "email" text NOT NULL, "password_hash" text NOT NULL, "name" text, "role" "public"."users_role_enum" NOT NULL DEFAULT 'operator', "status" "public"."users_status_enum" NOT NULL DEFAULT 'pending', CONSTRAINT "pk_users" PRIMARY KEY ("id"))`);
        await queryRunner.query(`CREATE UNIQUE INDEX "idx_users_email" ON "users" ("email") `);
        await queryRunner.query(`CREATE TYPE "public"."organization_members_role_enum" AS ENUM('owner', 'member')`);
        await queryRunner.query(`CREATE TABLE "organization_members" ("created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), "updated_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), "org_id" uuid NOT NULL, "user_id" uuid NOT NULL, "role" "public"."organization_members_role_enum" NOT NULL DEFAULT 'member', CONSTRAINT "pk_organization_members" PRIMARY KEY ("org_id", "user_id"))`);
        await queryRunner.query(`CREATE INDEX "idx_organization_members_user_id" ON "organization_members" ("user_id") `);
        await queryRunner.query(`ALTER TABLE "organization_members" ADD CONSTRAINT "fk_organization_members_org_id_organizations" FOREIGN KEY ("org_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE NO ACTION`);
        await queryRunner.query(`ALTER TABLE "organization_members" ADD CONSTRAINT "fk_organization_members_user_id_users" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE NO ACTION`);
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`ALTER TABLE "organization_members" DROP CONSTRAINT "fk_organization_members_user_id_users"`);
        await queryRunner.query(`ALTER TABLE "organization_members" DROP CONSTRAINT "fk_organization_members_org_id_organizations"`);
        await queryRunner.query(`DROP INDEX "public"."idx_organization_members_user_id"`);
        await queryRunner.query(`DROP TABLE "organization_members"`);
        await queryRunner.query(`DROP TYPE "public"."organization_members_role_enum"`);
        await queryRunner.query(`DROP INDEX "public"."idx_users_email"`);
        await queryRunner.query(`DROP TABLE "users"`);
        await queryRunner.query(`DROP TYPE "public"."users_status_enum"`);
        await queryRunner.query(`DROP TYPE "public"."users_role_enum"`);
        await queryRunner.query(`DROP TABLE "organizations"`);
        await queryRunner.query(`DROP TYPE "public"."organizations_status_enum"`);
    }

}
