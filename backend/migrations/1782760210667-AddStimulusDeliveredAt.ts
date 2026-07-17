import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Add `stimuli.delivered_at` — when an event was delivered to its thread's brain as a harness message.
 * Null until the delivery turn completes; the at-least-once boot sweep re-delivers any seeded event still
 * null. Chat rows never set it. (Generator jsonb-default noise on other tables was pruned.)
 */
export class AddStimulusDeliveredAt1782760210667 implements MigrationInterface {
  name = 'AddStimulusDeliveredAt1782760210667';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "stimuli" ADD "delivered_at" TIMESTAMP WITH TIME ZONE`);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "stimuli" DROP COLUMN "delivered_at"`);
  }
}
