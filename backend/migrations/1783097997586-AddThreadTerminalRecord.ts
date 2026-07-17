import { MigrationInterface, QueryRunner } from 'typeorm';

export class AddThreadTerminalRecord1783097997586 implements MigrationInterface {
  name = 'AddThreadTerminalRecord1783097997586';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "threads" ADD "terminal_record" jsonb`);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "threads" DROP COLUMN "terminal_record"`);
  }
}
