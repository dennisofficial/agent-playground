import { MigrationInterface, QueryRunner } from "typeorm";

export class AddThreadSandboxSessionId1782094986861 implements MigrationInterface {
    name = 'AddThreadSandboxSessionId1782094986861'

    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`ALTER TABLE "atlas_thread_sandboxes" ADD "session_id" text`);
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`ALTER TABLE "atlas_thread_sandboxes" DROP COLUMN "session_id"`);
    }
}
