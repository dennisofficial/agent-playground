import { MigrationInterface, QueryRunner } from 'typeorm';

export class AddThreadTurnActive1782593315663 implements MigrationInterface {
  name = 'AddThreadTurnActive1782593315663';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "threads" ADD "turn_active" boolean NOT NULL DEFAULT false`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "threads" DROP COLUMN "turn_active"`);
  }
}
