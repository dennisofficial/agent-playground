import { MigrationInterface, QueryRunner } from 'typeorm';

export class AddRepoOnboardingState1782793229183 implements MigrationInterface {
  name = 'AddRepoOnboardingState1782793229183';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "repos" ADD "onboarding_thread_id" uuid`,
    );
    await queryRunner.query(
      `ALTER TABLE "repos" ADD "onboarded_at" TIMESTAMP WITH TIME ZONE`,
    );
    await queryRunner.query(
      `ALTER TABLE "threads" ADD "awaiting_secret_id" text`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "threads" DROP COLUMN "awaiting_secret_id"`,
    );
    await queryRunner.query(`ALTER TABLE "repos" DROP COLUMN "onboarded_at"`);
    await queryRunner.query(
      `ALTER TABLE "repos" DROP COLUMN "onboarding_thread_id"`,
    );
  }
}
