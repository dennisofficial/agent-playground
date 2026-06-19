import { MigrationInterface, QueryRunner } from "typeorm";

/**
 * Subscription (OAuth) engine auth for tenant provider keys. Adds `engine_auth_mode`
 * ('api_key' default | 'subscription') + the encrypted `subscription_ciphertext` (a Claude OAuth
 * token or Codex auth.json blob), and relaxes `key_ciphertext` to nullable so a workspace can
 * register a subscription credential before/without an API key. Fully additive — existing rows keep
 * the exact prior behavior (mode 'api_key', null subscription). The generated `metrics_events`
 * default drift was pruned (not part of this change).
 */
export class AddProviderKeySubscriptionAuth1781842911501 implements MigrationInterface {
    name = 'AddProviderKeySubscriptionAuth1781842911501'

    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`ALTER TABLE "provider_keys" ADD "engine_auth_mode" text NOT NULL DEFAULT 'api_key'`);
        await queryRunner.query(`ALTER TABLE "provider_keys" ADD "subscription_ciphertext" text`);
        await queryRunner.query(`ALTER TABLE "provider_keys" ALTER COLUMN "key_ciphertext" DROP NOT NULL`);
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`ALTER TABLE "provider_keys" ALTER COLUMN "key_ciphertext" SET NOT NULL`);
        await queryRunner.query(`ALTER TABLE "provider_keys" DROP COLUMN "subscription_ciphertext"`);
        await queryRunner.query(`ALTER TABLE "provider_keys" DROP COLUMN "engine_auth_mode"`);
    }

}
