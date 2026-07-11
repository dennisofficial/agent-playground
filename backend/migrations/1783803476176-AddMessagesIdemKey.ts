import { MigrationInterface, QueryRunner } from "typeorm";

export class AddMessagesIdemKey1783803476176 implements MigrationInterface {
    name = 'AddMessagesIdemKey1783803476176'

    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`ALTER TABLE "messages" ADD "idem_key" text`);
        await queryRunner.query(`CREATE UNIQUE INDEX "ux_messages_idem_key" ON "messages" ("idem_key") WHERE "idem_key" IS NOT NULL`);
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`DROP INDEX "public"."ux_messages_idem_key"`);
        await queryRunner.query(`ALTER TABLE "messages" DROP COLUMN "idem_key"`);
    }

}
