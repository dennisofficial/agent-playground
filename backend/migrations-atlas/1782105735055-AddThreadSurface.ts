import { MigrationInterface, QueryRunner } from "typeorm";

export class AddThreadSurface1782105735055 implements MigrationInterface {
    name = 'AddThreadSurface1782105735055'

    public async up(queryRunner: QueryRunner): Promise<void> {
        // Which chat surface a thread lives on. NOT NULL DEFAULT 'slack' backfills every pre-existing row
        // to 'slack' (the only surface before multi-surface). The CompositeChatSurface dispatches on it.
        await queryRunner.query(`ALTER TABLE "atlas_threads" ADD "surface" text NOT NULL DEFAULT 'slack'`);
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`ALTER TABLE "atlas_threads" DROP COLUMN "surface"`);
    }
}
