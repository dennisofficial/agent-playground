import { MigrationInterface, QueryRunner } from 'typeorm';

export class AddJobDependencies1783742215718 implements MigrationInterface {
  name = 'AddJobDependencies1783742215718';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "jobs" ADD "blocked_seed_message" text`,
    );
    await queryRunner.query(
      `CREATE TABLE "job_dependencies" ("created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), "updated_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), "id" uuid NOT NULL DEFAULT uuid_generate_v4(), "org_id" uuid NOT NULL, "repo_id" uuid NOT NULL, "job_id" uuid NOT NULL, "depends_on_job_id" uuid NOT NULL, CONSTRAINT "uq_job_dependencies_job_id_depends_on_job_id" UNIQUE ("job_id", "depends_on_job_id"), CONSTRAINT "pk_job_dependencies" PRIMARY KEY ("id"))`,
    );
    await queryRunner.query(
      `CREATE INDEX "idx_job_dependencies_depends_on_job_id" ON "job_dependencies" ("depends_on_job_id") `,
    );
    await queryRunner.query(
      `CREATE INDEX "idx_job_dependencies_org_id_repo_id" ON "job_dependencies" ("org_id", "repo_id") `,
    );
    await queryRunner.query(
      `ALTER TABLE "job_dependencies" ADD CONSTRAINT "fk_job_dependencies_org_id_organizations" FOREIGN KEY ("org_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE NO ACTION`,
    );
    await queryRunner.query(
      `ALTER TABLE "job_dependencies" ADD CONSTRAINT "fk_job_dependencies_repo_id_repos" FOREIGN KEY ("repo_id") REFERENCES "repos"("id") ON DELETE CASCADE ON UPDATE NO ACTION`,
    );
    await queryRunner.query(
      `ALTER TABLE "job_dependencies" ADD CONSTRAINT "fk_job_dependencies_job_id_jobs" FOREIGN KEY ("job_id") REFERENCES "jobs"("id") ON DELETE CASCADE ON UPDATE NO ACTION`,
    );
    await queryRunner.query(
      `ALTER TABLE "job_dependencies" ADD CONSTRAINT "fk_job_dependencies_depends_on_job_id_jobs" FOREIGN KEY ("depends_on_job_id") REFERENCES "jobs"("id") ON DELETE CASCADE ON UPDATE NO ACTION`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "job_dependencies" DROP CONSTRAINT "fk_job_dependencies_depends_on_job_id_jobs"`,
    );
    await queryRunner.query(
      `ALTER TABLE "job_dependencies" DROP CONSTRAINT "fk_job_dependencies_job_id_jobs"`,
    );
    await queryRunner.query(
      `ALTER TABLE "job_dependencies" DROP CONSTRAINT "fk_job_dependencies_repo_id_repos"`,
    );
    await queryRunner.query(
      `ALTER TABLE "job_dependencies" DROP CONSTRAINT "fk_job_dependencies_org_id_organizations"`,
    );
    await queryRunner.query(
      `DROP INDEX "public"."idx_job_dependencies_org_id_repo_id"`,
    );
    await queryRunner.query(
      `DROP INDEX "public"."idx_job_dependencies_depends_on_job_id"`,
    );
    await queryRunner.query(`DROP TABLE "job_dependencies"`);
    await queryRunner.query(
      `ALTER TABLE "jobs" DROP COLUMN "blocked_seed_message"`,
    );
  }
}
