import { MigrationInterface, QueryRunner } from "typeorm";

export class AddSkillReviewApplicability1783643401945 implements MigrationInterface {
    name = 'AddSkillReviewApplicability1783643401945'

    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`ALTER TABLE "workspace_skills" ADD "review_for_types" jsonb NOT NULL DEFAULT '[]'`);
        await queryRunner.query(`ALTER TABLE "workspace_skills" ADD "review_for_globs" jsonb NOT NULL DEFAULT '[]'`);
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`ALTER TABLE "workspace_skills" DROP COLUMN "review_for_globs"`);
        await queryRunner.query(`ALTER TABLE "workspace_skills" DROP COLUMN "review_for_types"`);
    }

}
