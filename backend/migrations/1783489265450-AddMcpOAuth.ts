import { MigrationInterface, QueryRunner } from "typeorm";

export class AddMcpOAuth1783489265450 implements MigrationInterface {
    name = 'AddMcpOAuth1783489265450'

    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`ALTER TABLE "mcp_servers" ADD "auth_kind" text NOT NULL DEFAULT 'static'`);
        await queryRunner.query(`ALTER TABLE "mcp_servers" ADD "oauth_enc" text`);
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`ALTER TABLE "mcp_servers" DROP COLUMN "oauth_enc"`);
        await queryRunner.query(`ALTER TABLE "mcp_servers" DROP COLUMN "auth_kind"`);
    }

}
