import { MigrationInterface, QueryRunner } from "typeorm";

export class AddPlanReviewFinalizeNudgedAt1783111510422 implements MigrationInterface {
    name = 'AddPlanReviewFinalizeNudgedAt1783111510422'

    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`ALTER TABLE "plan_reviews" ADD "finalize_nudged_at" TIMESTAMP WITH TIME ZONE`);
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`ALTER TABLE "plan_reviews" DROP COLUMN "finalize_nudged_at"`);
    }

}
