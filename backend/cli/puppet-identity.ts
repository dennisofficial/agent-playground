/**
 * Shared by the `puppet:register` CLI and the dev `slack-identities` seed: encrypt a puppet bot
 * token (same v1 AES-256-GCM format as SecretCipher), resolve its Slack bot user id via
 * auth.test, and upsert the `slack_identities` row.
 */
import { createCipheriv, randomBytes } from 'node:crypto';
import { WebClient } from '@slack/web-api';
import type { DataSource } from 'typeorm';

export function encryptSecret(plain: string): string {
  const raw = process.env.SECRETS_ENCRYPTION_KEY;
  if (!raw) throw new Error('SECRETS_ENCRYPTION_KEY is not set');
  const key = /^[0-9a-fA-F]{64}$/.test(raw)
    ? Buffer.from(raw, 'hex')
    : Buffer.from(raw, 'base64');
  if (key.length !== 32)
    throw new Error(
      `SECRETS_ENCRYPTION_KEY must decode to 32 bytes (got ${key.length})`,
    );
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const ct = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `v1:${iv.toString('base64')}:${tag.toString('base64')}:${ct.toString('base64')}`;
}

/** auth.test → encrypt → upsert. Throws on a dead token (auth.test fails). */
export async function registerPuppet(
  ds: DataSource,
  opts: { team: string; botId: string; token: string },
): Promise<{ slackBotUserId: string }> {
  const auth = await new WebClient(opts.token).auth.test();
  const slackBotUserId = auth.user_id;
  if (!slackBotUserId) throw new Error('auth.test did not return a user_id');
  await ds.query(
    `INSERT INTO slack_identities (team_id, bot_id, token_ciphertext, slack_bot_user_id)
     VALUES ($1, $2, $3, $4)
     ON CONFLICT (team_id, bot_id) DO UPDATE SET
       token_ciphertext = EXCLUDED.token_ciphertext,
       slack_bot_user_id = COALESCE(EXCLUDED.slack_bot_user_id, slack_identities.slack_bot_user_id),
       updated_at = now()`,
    [opts.team, opts.botId, encryptSecret(opts.token), slackBotUserId],
  );
  return { slackBotUserId };
}
