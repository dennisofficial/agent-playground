import { MigrationInterface, QueryRunner } from 'typeorm';

export class AddLedgerPromotionColumns1782686991593 implements MigrationInterface {
  name = 'AddLedgerPromotionColumns1782686991593';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "threads" ADD "ledger_promotion_status" text`);
    await queryRunner.query(
      `ALTER TABLE "threads" ADD "ledger_promoted_at" TIMESTAMP WITH TIME ZONE`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "threads" DROP COLUMN "ledger_promoted_at"`);
    await queryRunner.query(`ALTER TABLE "threads" DROP COLUMN "ledger_promotion_status"`);
  }
}
