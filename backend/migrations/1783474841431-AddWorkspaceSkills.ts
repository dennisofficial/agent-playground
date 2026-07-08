import { MigrationInterface, QueryRunner } from "typeorm";

export class AddWorkspaceSkills1783474841431 implements MigrationInterface {
    name = 'AddWorkspaceSkills1783474841431'

    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`CREATE TABLE "workspace_skills" ("created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), "updated_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), "org_id" uuid NOT NULL, "scope" text NOT NULL DEFAULT '*', "name" text NOT NULL, "description" text NOT NULL, "body" text NOT NULL, "surfaces" jsonb NOT NULL DEFAULT '["build"]', "enabled" boolean NOT NULL DEFAULT true, CONSTRAINT "pk_workspace_skills" PRIMARY KEY ("org_id", "scope", "name"))`);
        await queryRunner.query(`CREATE INDEX "idx_workspace_skills_org_id" ON "workspace_skills" ("org_id") `);
        await queryRunner.query(`ALTER TABLE "workspace_skills" ADD CONSTRAINT "fk_workspace_skills_org_id_organizations" FOREIGN KEY ("org_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE NO ACTION`);
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`ALTER TABLE "workspace_skills" DROP CONSTRAINT "fk_workspace_skills_org_id_organizations"`);
        await queryRunner.query(`DROP INDEX "public"."idx_workspace_skills_org_id"`);
        await queryRunner.query(`DROP TABLE "workspace_skills"`);
    }

}
