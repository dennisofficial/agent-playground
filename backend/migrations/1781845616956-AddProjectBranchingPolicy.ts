import { MigrationInterface, QueryRunner } from "typeorm";

export class AddProjectBranchingPolicy1781845616956 implements MigrationInterface {
    name = 'AddProjectBranchingPolicy1781845616956'

    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`ALTER TABLE "projects" ADD "branching_policy" jsonb`);
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`ALTER TABLE "projects" DROP COLUMN "branching_policy"`);
    }

}
