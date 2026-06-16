import { MigrationInterface, QueryRunner } from "typeorm";

export class AddSharedSlugToTeamTasks1781570887059 implements MigrationInterface {
    name = 'AddSharedSlugToTeamTasks1781570887059'

    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`ALTER TABLE "team_tasks" ADD "shared_slug" text`);
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`ALTER TABLE "team_tasks" DROP COLUMN "shared_slug"`);
    }

}
