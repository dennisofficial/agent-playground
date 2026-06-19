import { EnvService } from '@core/config/env/env.service';
import { envConfigValidation } from '@core/config/env/validation';
import { Test, TestingModule } from '@nestjs/testing';
import { EnvModule } from '@workspace/nestjs-core';
import { ProviderKey } from '@workspace/shared/schemas';
import { randomBytes } from 'node:crypto';
import { DataSource } from 'typeorm';
import { DatabaseModule } from '../../_lib/database/database.module';
import { LlmKeysModule } from './llm-keys.module';
import { ProviderKeyStore } from './provider-key.store';

/**
 * Proves the subscription-auth columns survive a real encrypt → store → decrypt round-trip against
 * live Postgres (the unit specs use a fake store; this covers the actual SQL + AES seam + the
 * nullable key_ciphertext the migration introduced).
 */
describe('ProviderKeyStore subscription auth (live Postgres)', () => {
  const T = `team-int-${Date.now().toString(36)}`;
  let moduleRef: TestingModule;
  let store: ProviderKeyStore;

  beforeAll(async () => {
    process.env.SECRETS_ENCRYPTION_KEY = randomBytes(32).toString('base64');
    moduleRef = await Test.createTestingModule({
      imports: [
        EnvModule.forRoot({
          envService: EnvService,
          validationSchema: envConfigValidation,
        }),
        DatabaseModule,
        LlmKeysModule,
      ],
    }).compile();
    await moduleRef.init();
    store = moduleRef.get(ProviderKeyStore);
  });

  afterAll(async () => {
    const ds = moduleRef.get(DataSource);
    await ds
      .getRepository(ProviderKey)
      .createQueryBuilder()
      .delete()
      .where('team_id = :t', { t: T })
      .execute();
    await moduleRef.close();
  });

  it('defaults to api_key mode with no subscription secret', async () => {
    await store.put(T, 'anthropic', 'sk-ant-api');
    const cred = await store.resolveCredential(T, 'anthropic');
    expect(cred).toEqual({
      apiKey: 'sk-ant-api',
      engineAuthMode: 'api_key',
      subscriptionSecret: undefined,
    });
  });

  it('stores + decrypts a subscription secret WITHOUT disturbing the API key', async () => {
    await store.putSubscription(
      T,
      'anthropic',
      'subscription',
      'oauth-token-xyz',
    );
    const cred = await store.resolveCredential(T, 'anthropic');
    expect(cred).toEqual({
      apiKey: 'sk-ant-api', // untouched by putSubscription
      engineAuthMode: 'subscription',
      subscriptionSecret: 'oauth-token-xyz',
    });
  });

  it('flips the mode back to api_key while KEEPING the stored secret (secret omitted)', async () => {
    await store.putSubscription(T, 'anthropic', 'api_key');
    const cred = await store.resolveCredential(T, 'anthropic');
    expect(cred?.engineAuthMode).toBe('api_key');
    expect(cred?.subscriptionSecret).toBe('oauth-token-xyz'); // COALESCE kept it
  });

  it('accepts a subscription credential before any API key (nullable key_ciphertext)', async () => {
    await store.putSubscription(T, 'openai', 'subscription', 'codex-auth-json');
    const cred = await store.resolveCredential(T, 'openai');
    expect(cred).toEqual({
      apiKey: undefined,
      engineAuthMode: 'subscription',
      subscriptionSecret: 'codex-auth-json',
    });
  });

  it('exposes non-secret state via listMeta', async () => {
    const meta = await store.listMeta(T);
    const openai = meta.find((m) => m.provider === 'openai');
    expect(openai).toMatchObject({
      engineAuthMode: 'subscription',
      hasApiKey: false,
      hasSubscription: true,
    });
  });
});
