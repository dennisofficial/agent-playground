import { MigrationInterface, QueryRunner } from "typeorm";

/**
 * Generated against the live schema, then pruned to the intended diff (the generator also emitted
 * TypeORM-invisible noise: the pgvector HNSW index drop, partial-index recreates, default churn).
 *
 *  - `channels`: the channel registry — one row per room (group chat / DM), channel→project mapping
 *    for memory scoping, membership for routing, kind for identity + gate rules.
 *  - `channel_messages` PK becomes (id, surface_id): message ids are surface-native (a Slack ts, a
 *    minted TUI id) and only unique within their channel — under the old global-id PK, two channels
 *    carrying the same id would silently upsert over each other.
 */
export class ChannelIdentityAndRegistry1781105430511 implements MigrationInterface {
    name = 'ChannelIdentityAndRegistry1781105430511'

    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`CREATE TABLE "channels" ("created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), "updated_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), "channel_id" text NOT NULL, "kind" text NOT NULL, "project" text NOT NULL, "members" text array NOT NULL DEFAULT '{}', "display_name" text NOT NULL, CONSTRAINT "pk_channels" PRIMARY KEY ("channel_id"))`);
        await queryRunner.query(`ALTER TABLE "channel_messages" DROP CONSTRAINT "channel_messages_pkey"`);
        await queryRunner.query(`ALTER TABLE "channel_messages" ADD CONSTRAINT "channel_messages_pkey" PRIMARY KEY ("id", "surface_id")`);
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`ALTER TABLE "channel_messages" DROP CONSTRAINT "channel_messages_pkey"`);
        await queryRunner.query(`ALTER TABLE "channel_messages" ADD CONSTRAINT "channel_messages_pkey" PRIMARY KEY ("id")`);
        await queryRunner.query(`DROP TABLE "channels"`);
    }
}
