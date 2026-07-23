import { MigrationInterface, QueryRunner } from 'typeorm';

export class Phase2RealtimeReplicaIdentityFull1784839787644 implements MigrationInterface {
  name = 'Phase2RealtimeReplicaIdentityFull1784839787644';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "organizations" REPLICA IDENTITY FULL`);
    await queryRunner.query(`ALTER TABLE "organization_members" REPLICA IDENTITY FULL`);
    await queryRunner.query(`ALTER TABLE "repos" REPLICA IDENTITY FULL`);
    await queryRunner.query(`ALTER TABLE "agent_credentials" REPLICA IDENTITY FULL`);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "organizations" REPLICA IDENTITY DEFAULT`);
    await queryRunner.query(`ALTER TABLE "organization_members" REPLICA IDENTITY DEFAULT`);
    await queryRunner.query(`ALTER TABLE "repos" REPLICA IDENTITY DEFAULT`);
    await queryRunner.query(`ALTER TABLE "agent_credentials" REPLICA IDENTITY DEFAULT`);
  }
}
