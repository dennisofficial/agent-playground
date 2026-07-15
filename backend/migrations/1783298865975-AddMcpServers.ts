import { MigrationInterface, QueryRunner } from 'typeorm';

export class AddMcpServers1783298865975 implements MigrationInterface {
  name = 'AddMcpServers1783298865975';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `CREATE TABLE "mcp_servers" ("created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), "updated_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), "org_id" uuid NOT NULL, "scope" text NOT NULL DEFAULT '*', "name" text NOT NULL, "transport" text NOT NULL, "config" jsonb NOT NULL DEFAULT '{}', "secrets_enc" text, "surfaces" jsonb NOT NULL DEFAULT '["brain","build"]', "enabled" boolean NOT NULL DEFAULT true, "discovered_tools" jsonb, "last_validated_at" TIMESTAMP WITH TIME ZONE, "validation_error" text, CONSTRAINT "pk_mcp_servers" PRIMARY KEY ("org_id", "scope", "name"))`,
    );
    await queryRunner.query(
      `CREATE INDEX "idx_mcp_servers_org_id" ON "mcp_servers" ("org_id") `,
    );
    await queryRunner.query(
      `ALTER TABLE "mcp_servers" ADD CONSTRAINT "fk_mcp_servers_org_id_organizations" FOREIGN KEY ("org_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE NO ACTION`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "mcp_servers" DROP CONSTRAINT "fk_mcp_servers_org_id_organizations"`,
    );
    await queryRunner.query(`DROP INDEX "public"."idx_mcp_servers_org_id"`);
    await queryRunner.query(`DROP TABLE "mcp_servers"`);
  }
}
