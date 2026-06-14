import type { Seeder } from '@workspace/nestjs-core';
import { registerPuppet } from '../cli/puppet-identity';

/**
 * Re-seeds the dev workspace's puppet identities after a DB recreate, from `SLACK_PUPPET_SEED`
 * in the committed, encrypted `.env.local.enc` (a `.env.personal` entry still overrides it):
 *
 *   SLACK_PUPPET_SEED={"teamId":"T0...","tokens":{"alex":"xoxb-…","sam":"xoxb-…"}}
 *
 * Idempotent (upsert), and each token round-trips auth.test, so user ids stay correct and a
 * revoked token fails loudly here instead of silently at runtime. Unset → skipped.
 */
export default (async (ds) => {
  const raw = process.env.SLACK_PUPPET_SEED;
  if (!raw) {
    console.log('  SLACK_PUPPET_SEED not set — skipping puppet identities');
    return;
  }
  const { teamId, tokens } = JSON.parse(raw) as {
    teamId: string;
    tokens: Record<string, string>;
  };
  if (!teamId || !tokens) {
    throw new Error(
      'SLACK_PUPPET_SEED must be {"teamId":"T0...","tokens":{"<botId>":"xoxb-..."}}',
    );
  }
  for (const [botId, token] of Object.entries(tokens)) {
    const { slackBotUserId } = await registerPuppet(ds, {
      team: teamId,
      botId,
      token,
    });
    console.log(`  ✓ ${botId} → ${teamId} (bot user: ${slackBotUserId})`);
  }
}) satisfies Seeder;
