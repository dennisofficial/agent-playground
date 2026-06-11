import { MigrationInterface, QueryRunner } from "typeorm";

export class RenameChannelMessagesAndTasksIndexes1781139383998 implements MigrationInterface {
    name = 'RenameChannelMessagesAndTasksIndexes1781139383998'

    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`DROP INDEX "public"."uq_channel_messages_surface_id_seq"`);
        await queryRunner.query(`DROP INDEX "public"."idx_facts_embedding_hnsw"`);
        await queryRunner.query(`DROP INDEX "public"."uq_tasks_project_owner_norm"`);
        await queryRunner.query(`ALTER TABLE "facts" ALTER COLUMN "confidence" SET DEFAULT '1'`);
        await queryRunner.query(`CREATE UNIQUE INDEX "idx_channel_messages_surface_id_seq" ON "channel_messages" ("surface_id", "seq") `);
        await queryRunner.query(`CREATE UNIQUE INDEX "idx_tasks_project_owner_norm" ON "tasks" ("project", "owner", "norm") WHERE status = 'open'`);
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`DROP INDEX "public"."idx_tasks_project_owner_norm"`);
        await queryRunner.query(`DROP INDEX "public"."idx_channel_messages_surface_id_seq"`);
        await queryRunner.query(`ALTER TABLE "facts" ALTER COLUMN "confidence" SET DEFAULT 1.0`);
        await queryRunner.query(`CREATE UNIQUE INDEX "uq_tasks_project_owner_norm" ON "tasks" ("project", "norm", "owner") WHERE (status = 'open'::text)`);
        await queryRunner.query(`CREATE INDEX "idx_facts_embedding_hnsw" ON "facts" ("embedding") `);
        await queryRunner.query(`CREATE UNIQUE INDEX "uq_channel_messages_surface_id_seq" ON "channel_messages" ("seq", "surface_id") `);
    }

}
