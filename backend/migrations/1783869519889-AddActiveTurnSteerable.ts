import { MigrationInterface, QueryRunner } from 'typeorm';

export class AddActiveTurnSteerable1783869519889 implements MigrationInterface {
  name = 'AddActiveTurnSteerable1783869519889';

  public async up(queryRunner: QueryRunner): Promise<void> {
    // Persist per-turn steerability (see ActiveTurnEntity.steerable): true iff the turn opened its
    // `turn:{turn_id}:input` steering stream at start. The lane-generic host steer/stop resolver
    // (`runningSteerableTurn`) queries this instead of the `kind` heuristic. NOT NULL DEFAULT false
    // backfills existing rows as non-steerable. Generator noise (unrelated index/constraint churn)
    // pruned per the migrations house rule.
    await queryRunner.query(
      `ALTER TABLE "active_turns" ADD "steerable" boolean NOT NULL DEFAULT false`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "active_turns" DROP COLUMN "steerable"`);
  }
}
