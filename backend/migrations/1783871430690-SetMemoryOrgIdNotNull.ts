import { MigrationInterface, QueryRunner } from "typeorm";

/**
 * Enforce `memory.org_id NOT NULL` at the DB. The shared/global memory tier (`org_id IS NULL`,
 * "recalled everywhere") is removed — memory is now strictly tenant-scoped, so every fact must
 * carry an owning org. Safe: prod has 0 rows with `org_id IS NULL`. The FK to `organizations`
 * (ON DELETE CASCADE) and `idx_memory_org_id_scope` are unchanged and left in place.
 */
export class SetMemoryOrgIdNotNull1783871430690 implements MigrationInterface {
    name = 'SetMemoryOrgIdNotNull1783871430690'

    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`ALTER TABLE "memory" ALTER COLUMN "org_id" SET NOT NULL`);
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`ALTER TABLE "memory" ALTER COLUMN "org_id" DROP NOT NULL`);
    }

}
