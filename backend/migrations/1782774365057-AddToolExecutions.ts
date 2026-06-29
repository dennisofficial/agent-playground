import { MigrationInterface, QueryRunner } from "typeorm";

export class AddToolExecutions1782774365057 implements MigrationInterface {
    name = 'AddToolExecutions1782774365057'

    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`CREATE TABLE "tool_executions" ("created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), "updated_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), "turn_id" uuid NOT NULL, "tool_call_id" uuid NOT NULL, "tool_name" text NOT NULL, "reply" jsonb NOT NULL, CONSTRAINT "pk_tool_executions" PRIMARY KEY ("turn_id", "tool_call_id"))`);
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`DROP TABLE "tool_executions"`);
    }

}
