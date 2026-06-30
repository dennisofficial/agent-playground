import { MigrationInterface, QueryRunner } from "typeorm";

export class AddTrackReviewAgents1782788462336 implements MigrationInterface {
    name = 'AddTrackReviewAgents1782788462336'

    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`ALTER TABLE "tracks" ADD "review_agents" jsonb NOT NULL DEFAULT '[]'`);
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`ALTER TABLE "tracks" DROP COLUMN "review_agents"`);
    }

}
