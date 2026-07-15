import { MigrationInterface, QueryRunner } from "typeorm";

/**
 * Add the nullable `repos.preview_instructions` text column — the per-repo, Atlas-managed
 * preview recipe spliced into the "Spin up preview" seed. Mirrors `setup_script`; nullable, no
 * default (null → no recipe saved yet).
 */
export class AddRepoPreviewInstructions1784010000000 implements MigrationInterface {
    name = 'AddRepoPreviewInstructions1784010000000'

    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`ALTER TABLE "repos" ADD "preview_instructions" text`);
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`ALTER TABLE "repos" DROP COLUMN "preview_instructions"`);
    }
}
