import { MigrationInterface, QueryRunner } from "typeorm";

export class AddThreadOrientation1783046714980 implements MigrationInterface {
    name = 'AddThreadOrientation1783046714980'

    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`ALTER TABLE "threads" ADD "orientation" text`);
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`ALTER TABLE "threads" DROP COLUMN "orientation"`);
    }

}
