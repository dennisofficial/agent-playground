import { MigrationInterface, QueryRunner } from "typeorm";

export class AddProjectDescriptionAndSessionReferences1781748053690 implements MigrationInterface {
    name = 'AddProjectDescriptionAndSessionReferences1781748053690'

    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`ALTER TABLE "projects" ADD "description" text`);
        await queryRunner.query(`ALTER TABLE "sessions" ADD "referenced_projects" jsonb`);
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`ALTER TABLE "sessions" DROP COLUMN "referenced_projects"`);
        await queryRunner.query(`ALTER TABLE "projects" DROP COLUMN "description"`);
    }

}
