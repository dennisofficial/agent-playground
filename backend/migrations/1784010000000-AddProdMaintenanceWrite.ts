import { MigrationInterface, QueryRunner } from "typeorm";

/**
 * The `prod_maintenance_write` audit/pending ledger backing the human-gated prod-recovery write path
 * (the `atlas-prod` MCP). One append-then-update row per proposed write: `status` tracks the lifecycle
 * (pending → approved → executed | failed, or rejected | superseded) and doubles as the durable audit
 * record. Written only by the backend's `app` connection — never the DML-only `mcp_writer` role.
 */
export class AddProdMaintenanceWrite1784010000000 implements MigrationInterface {
    name = 'AddProdMaintenanceWrite1784010000000'

    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`CREATE TABLE "prod_maintenance_write" ("created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), "updated_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), "id" uuid NOT NULL DEFAULT uuid_generate_v4(), "org_id" uuid NOT NULL, "repo_id" text NOT NULL, "job_id" uuid NOT NULL, "proposed_by_session" text, "sql" text NOT NULL, "status" text NOT NULL DEFAULT 'pending', "dry_run" jsonb NOT NULL, "approved_by" uuid, "approved_at" TIMESTAMP WITH TIME ZONE, "executed_at" TIMESTAMP WITH TIME ZONE, "result" jsonb, CONSTRAINT "pk_prod_maintenance_write" PRIMARY KEY ("id"))`);
        await queryRunner.query(`CREATE INDEX "idx_prod_maintenance_write_job_id_status" ON "prod_maintenance_write" ("job_id", "status")`);
        await queryRunner.query(`
            DO $$
            BEGIN
                IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'mcp_writer') THEN
                    REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON "prod_maintenance_write" FROM mcp_writer;
                END IF;
            END
            $$;
        `);
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`DROP INDEX "public"."idx_prod_maintenance_write_job_id_status"`);
        await queryRunner.query(`DROP TABLE "prod_maintenance_write"`);
    }

}
