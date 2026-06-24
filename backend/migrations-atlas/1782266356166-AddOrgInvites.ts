import { MigrationInterface, QueryRunner } from "typeorm";

export class AddOrgInvites1782266356166 implements MigrationInterface {
    name = 'AddOrgInvites1782266356166'

    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`CREATE TABLE "atlas_org_invites" ("created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), "updated_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), "token" text NOT NULL, "org_id" text NOT NULL, "email" text NOT NULL, "role" text NOT NULL DEFAULT 'member', "invited_by" text NOT NULL, "accepted_at" TIMESTAMP WITH TIME ZONE, "accepted_by" text, CONSTRAINT "pk_atlas_org_invites" PRIMARY KEY ("token"))`);
        await queryRunner.query(`CREATE INDEX "idx_atlas_org_invites_email" ON "atlas_org_invites" ("email") `);
        await queryRunner.query(`CREATE INDEX "idx_atlas_org_invites_org_id" ON "atlas_org_invites" ("org_id") `);
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`DROP INDEX "public"."idx_atlas_org_invites_org_id"`);
        await queryRunner.query(`DROP INDEX "public"."idx_atlas_org_invites_email"`);
        await queryRunner.query(`DROP TABLE "atlas_org_invites"`);
    }

}
