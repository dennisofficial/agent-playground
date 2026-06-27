import { MigrationInterface, QueryRunner } from "typeorm";

export class AddPhaseBatchOrdinal1782522962377 implements MigrationInterface {
    name = 'AddPhaseBatchOrdinal1782522962377'

    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`ALTER TABLE "phases" ADD "batch_ordinal" integer`);
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`ALTER TABLE "phases" DROP COLUMN "batch_ordinal"`);
    }

}
