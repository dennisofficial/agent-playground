import { MigrationInterface, QueryRunner } from 'typeorm';

export class AddPlanReviewError1782661787059 implements MigrationInterface {
  name = 'AddPlanReviewError1782661787059';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "plan_reviews" ADD "error" text`);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "plan_reviews" DROP COLUMN "error"`);
  }
}
