import { MigrationInterface, QueryRunner } from "typeorm";

export class AddGithubAppInstallationColumns1784674216389 implements MigrationInterface {
    name = 'AddGithubAppInstallationColumns1784674216389'

    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`ALTER TABLE "org_credentials" ADD "github_app_installation_id" text`);
        await queryRunner.query(`ALTER TABLE "org_credentials" ADD "github_app_installation_account" text`);
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`ALTER TABLE "org_credentials" DROP COLUMN "github_app_installation_account"`);
        await queryRunner.query(`ALTER TABLE "org_credentials" DROP COLUMN "github_app_installation_id"`);
    }

}
