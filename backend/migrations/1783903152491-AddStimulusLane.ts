import { MigrationInterface, QueryRunner } from "typeorm";

export class AddStimulusLane1783903152491 implements MigrationInterface {
    name = 'AddStimulusLane1783903152491'

    public async up(queryRunner: QueryRunner): Promise<void> {
        // The routing coordinate within `job_id` (see StimulusEntity.lane): 'main' (brain) or
        // 'thread:<threadId>' (a build lane). NOT NULL DEFAULT 'main' backfills existing rows so
        // brain callers, which never set it, route unchanged. Generator noise (unrelated FK/index
        // churn from the naming-strategy diff) pruned per the migrations house rule.
        await queryRunner.query(`ALTER TABLE "stimuli" ADD "lane" text NOT NULL DEFAULT 'main'`);
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`ALTER TABLE "stimuli" DROP COLUMN "lane"`);
    }

}
