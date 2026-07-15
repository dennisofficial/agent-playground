import { MigrationInterface, QueryRunner } from 'typeorm';

export class AddProfileSeenManifests1783561046789 implements MigrationInterface {
  name = 'AddProfileSeenManifests1783561046789';

  // Additive nullable jsonb column: the manifest set the Workspace Profile has acknowledged, for
  // new-stack detection (`repos.profile_seen_manifests`). Generator index churn (HNSW / partial-unique)
  // pruned.
  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "repos" ADD "profile_seen_manifests" jsonb`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "repos" DROP COLUMN "profile_seen_manifests"`,
    );
  }
}
