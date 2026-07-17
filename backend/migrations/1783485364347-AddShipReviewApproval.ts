import { MigrationInterface, QueryRunner } from 'typeorm';

export class AddShipReviewApproval1783485364347 implements MigrationInterface {
  name = 'AddShipReviewApproval1783485364347';

  public async up(queryRunner: QueryRunner): Promise<void> {
    // The ship-review gate marker (see JobEntity.ship_review_approved_at). Generator noise (the HNSW +
    // partial-unique index drops/recreates it can't model) pruned per the migrations house rule.
    await queryRunner.query(
      `ALTER TABLE "jobs" ADD "ship_review_approved_at" TIMESTAMP WITH TIME ZONE`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "jobs" DROP COLUMN "ship_review_approved_at"`);
  }
}
