import { MigrationInterface, QueryRunner } from "typeorm";

export class JobRealtimeReplicaIdentityFull1784836695849 implements MigrationInterface {
    name = 'JobRealtimeReplicaIdentityFull1784836695849'

    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`ALTER TABLE "jobs" REPLICA IDENTITY FULL`);
        await queryRunner.query(`ALTER TABLE "thread_groups" REPLICA IDENTITY FULL`);
        await queryRunner.query(`ALTER TABLE "threads" REPLICA IDENTITY FULL`);
        await queryRunner.query(`ALTER TABLE "thread_messages" REPLICA IDENTITY FULL`);
        await queryRunner.query(`ALTER TABLE "inbound_messages" REPLICA IDENTITY FULL`);
        await queryRunner.query(`ALTER TABLE "tasks" REPLICA IDENTITY FULL`);
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`ALTER TABLE "jobs" REPLICA IDENTITY DEFAULT`);
        await queryRunner.query(`ALTER TABLE "thread_groups" REPLICA IDENTITY DEFAULT`);
        await queryRunner.query(`ALTER TABLE "threads" REPLICA IDENTITY DEFAULT`);
        await queryRunner.query(`ALTER TABLE "thread_messages" REPLICA IDENTITY DEFAULT`);
        await queryRunner.query(`ALTER TABLE "inbound_messages" REPLICA IDENTITY DEFAULT`);
        await queryRunner.query(`ALTER TABLE "tasks" REPLICA IDENTITY DEFAULT`);
    }

}
