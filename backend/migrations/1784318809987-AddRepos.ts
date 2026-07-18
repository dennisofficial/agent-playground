import { MigrationInterface, QueryRunner } from 'typeorm';

export class AddRepos1784318809987 implements MigrationInterface {
  name = 'AddRepos1784318809987';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `CREATE TYPE "public"."repos_default_auto_merge_method_enum" AS ENUM('merge', 'squash', 'rebase')`,
    );
    await queryRunner.query(
      `CREATE TABLE "repos" ("created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), "updated_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), "id" uuid NOT NULL DEFAULT uuid_generate_v4(), "org_id" uuid NOT NULL, "slug" text NOT NULL, "name" text NOT NULL, "git_url" text NOT NULL, "default_branch" text NOT NULL DEFAULT 'main', "branch_prefix" text, "default_auto_merge_method" "public"."repos_default_auto_merge_method_enum" NOT NULL DEFAULT 'squash', "default_auto_merge_delete_branch" boolean NOT NULL DEFAULT true, "access_ok" boolean NOT NULL DEFAULT false, "access_checked_at" TIMESTAMP WITH TIME ZONE, "webhook_warning" text, "onboarding_thread_id" uuid, "onboarded_at" TIMESTAMP WITH TIME ZONE, "thread_count" integer NOT NULL DEFAULT '0', CONSTRAINT "pk_repos" PRIMARY KEY ("id"))`,
    );
    await queryRunner.query(
      `CREATE UNIQUE INDEX "idx_repos_org_id_slug" ON "repos" ("org_id", "slug") `,
    );
    await queryRunner.query(`CREATE INDEX "idx_repos_org_id" ON "repos" ("org_id") `);
    await queryRunner.query(
      `ALTER TABLE "repos" ADD CONSTRAINT "fk_repos_org_id_organizations" FOREIGN KEY ("org_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE NO ACTION`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "repos" DROP CONSTRAINT "fk_repos_org_id_organizations"`);
    await queryRunner.query(`DROP INDEX "public"."idx_repos_org_id"`);
    await queryRunner.query(`DROP INDEX "public"."idx_repos_org_id_slug"`);
    await queryRunner.query(`DROP TABLE "repos"`);
    await queryRunner.query(`DROP TYPE "public"."repos_default_auto_merge_method_enum"`);
  }
}
