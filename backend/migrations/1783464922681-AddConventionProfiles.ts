import { MigrationInterface, QueryRunner } from 'typeorm';

export class AddConventionProfiles1783464922681 implements MigrationInterface {
  name = 'AddConventionProfiles1783464922681';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `CREATE TABLE "convention_profiles" ("created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), "updated_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), "org_id" uuid NOT NULL, "slug" text NOT NULL, "name" text NOT NULL, "body" text NOT NULL, "detect_hint" text, CONSTRAINT "pk_convention_profiles" PRIMARY KEY ("org_id", "slug"))`,
    );
    await queryRunner.query(
      `CREATE INDEX "idx_convention_profiles_org_id" ON "convention_profiles" ("org_id") `,
    );
    await queryRunner.query(
      `ALTER TABLE "repos" ADD "convention_profile_slug" text`,
    );
    await queryRunner.query(
      `ALTER TABLE "convention_profiles" ADD CONSTRAINT "fk_convention_profiles_org_id_organizations" FOREIGN KEY ("org_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE NO ACTION`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "convention_profiles" DROP CONSTRAINT "fk_convention_profiles_org_id_organizations"`,
    );
    await queryRunner.query(
      `ALTER TABLE "repos" DROP COLUMN "convention_profile_slug"`,
    );
    await queryRunner.query(
      `DROP INDEX "public"."idx_convention_profiles_org_id"`,
    );
    await queryRunner.query(`DROP TABLE "convention_profiles"`);
  }
}
