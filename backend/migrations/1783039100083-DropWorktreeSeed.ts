import { MigrationInterface, QueryRunner } from "typeorm";

/**
 * Drops the golden-seed worktree mechanism entirely. The `org_worktree_seed` table backed
 * `write_worktree_config({ seed })` + the `ATLAS_GOLDEN_ROOT` host-copy hydration path — a half-built
 * feature (no tooling ever populated the golden root, so recorded seeds silently never materialized).
 * Replaced by committing non-secret defaults or using request_secret/request_file. TypeORM's
 * migration:generate cannot emit this (an orphaned table with no entity is invisible to its differ), so
 * it is authored by hand — the seed-only inverse of AddWorktreeMountsAndSeed.
 */
export class DropWorktreeSeed1783039100083 implements MigrationInterface {
    name = 'DropWorktreeSeed1783039100083'

    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`ALTER TABLE "org_worktree_seed" DROP CONSTRAINT "fk_org_worktree_seed_repo_id_repos"`);
        await queryRunner.query(`ALTER TABLE "org_worktree_seed" DROP CONSTRAINT "fk_org_worktree_seed_org_id_organizations"`);
        await queryRunner.query(`DROP INDEX "public"."idx_org_worktree_seed_org_id"`);
        await queryRunner.query(`DROP INDEX "public"."idx_org_worktree_seed_org_id_repo_id"`);
        await queryRunner.query(`DROP TABLE "org_worktree_seed"`);
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`CREATE TABLE "org_worktree_seed" ("created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), "updated_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), "org_id" uuid NOT NULL, "repo_id" uuid NOT NULL, "path" text NOT NULL, CONSTRAINT "pk_org_worktree_seed" PRIMARY KEY ("org_id", "repo_id", "path"))`);
        await queryRunner.query(`CREATE INDEX "idx_org_worktree_seed_org_id_repo_id" ON "org_worktree_seed" ("org_id", "repo_id") `);
        await queryRunner.query(`CREATE INDEX "idx_org_worktree_seed_org_id" ON "org_worktree_seed" ("org_id") `);
        await queryRunner.query(`ALTER TABLE "org_worktree_seed" ADD CONSTRAINT "fk_org_worktree_seed_org_id_organizations" FOREIGN KEY ("org_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE NO ACTION`);
        await queryRunner.query(`ALTER TABLE "org_worktree_seed" ADD CONSTRAINT "fk_org_worktree_seed_repo_id_repos" FOREIGN KEY ("repo_id") REFERENCES "repos"("id") ON DELETE CASCADE ON UPDATE NO ACTION`);
    }

}
