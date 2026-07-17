import { MigrationInterface, QueryRunner } from 'typeorm';

export class AddProfileSeenTooling1783994921567 implements MigrationInterface {
  name = 'AddProfileSeenTooling1783994921567';

  // Additive nullable jsonb column: the per-repo seen-tooling ledger for the install-awareness nudge
  // (`repos.profile_seen_tooling`). Generator naming-strategy churn (unrelated FK/index renames) pruned.
  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "repos" ADD "profile_seen_tooling" jsonb`);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "repos" DROP COLUMN "profile_seen_tooling"`);
  }
}
