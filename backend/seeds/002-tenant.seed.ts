import type { Seeder } from '@workspace/nestjs-core';
import { WebClient } from '@slack/web-api';
import { encryptSecret } from '../cli/puppet-identity';

/**
 * Re-seeds the dev workspace's TENANT row after a DB recreate, from the gitignored
 * `SLACK_TENANT_SEED` in `.env.personal`:
 *
 *   SLACK_TENANT_SEED={"teamId":"T0...","botToken":"xoxb-…","installedBy":"U0..."}
 *
 * Socket-mode dev never goes through the OAuth install that normally creates this row, so without
 * the seed the ears client runs on the env-token fallback and `installed_by` is null (which makes
 * the approval cards' boss check fall back to APPROVAL_BOSS_USER_ID). Seeding it makes dev behave
 * like an installed workspace: encrypted token in `tenants` (same v1 AES-256-GCM as OAuth writes),
 * boss check off `installed_by`. Idempotent (upsert); the token round-trips auth.test so a revoked
 * token fails loudly here; team name comes from auth.test. Unset → skipped (personal-machine
 * config, not a fixture).
 */
export default (async (ds) => {
  const raw = process.env.SLACK_TENANT_SEED;
  if (!raw) {
    console.log('  SLACK_TENANT_SEED not set — skipping tenant row');
    return;
  }
  const { teamId, botToken, installedBy } = JSON.parse(raw) as {
    teamId: string;
    botToken: string;
    installedBy?: string;
  };
  if (!teamId || !botToken) {
    throw new Error(
      'SLACK_TENANT_SEED must be {"teamId":"T0...","botToken":"xoxb-...","installedBy":"U0..."}',
    );
  }
  const auth = await new WebClient(botToken).auth.test();
  if (auth.team_id && auth.team_id !== teamId) {
    throw new Error(
      `SLACK_TENANT_SEED token belongs to ${auth.team_id}, not ${teamId} — wrong workspace?`,
    );
  }
  await ds.query(
    `INSERT INTO tenants (team_id, team_name, status, bot_token_ciphertext, installed_by)
     VALUES ($1, $2, 'active', $3, $4)
     ON CONFLICT (team_id) DO UPDATE SET
       team_name = EXCLUDED.team_name,
       bot_token_ciphertext = EXCLUDED.bot_token_ciphertext,
       installed_by = COALESCE(EXCLUDED.installed_by, tenants.installed_by),
       status = 'active',
       updated_at = now()`,
    [teamId, auth.team ?? teamId, encryptSecret(botToken), installedBy ?? null],
  );
  console.log(
    `  ✓ tenant ${teamId} (${auth.team ?? '?'}) seeded${installedBy ? ` — installed_by ${installedBy}` : ''}`,
  );
}) satisfies Seeder;
