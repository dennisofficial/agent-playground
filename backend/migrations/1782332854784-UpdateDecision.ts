import { MigrationInterface, QueryRunner } from 'typeorm';

export class UpdateDecision1782332854784 implements MigrationInterface {
  name = 'UpdateDecision1782332854784';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "decision_records" ALTER COLUMN "decisions" SET DEFAULT '[]'::jsonb`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "decision_records" ALTER COLUMN "decisions" SET DEFAULT '[]'`,
    );
  }
}
