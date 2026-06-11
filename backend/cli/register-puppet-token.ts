/**
 * Manual fallback for registering a puppet app's bot token when the OAuth callback isn't used.
 * Calls auth.test to capture the bot's Slack user ID automatically.
 * (For local dev, prefer the `SLACK_PUPPET_SEED` env + `pnpm db:seed` — survives DB recreates.)
 *
 * Usage:
 *   pnpm puppet:register --team T0XXXXXXX --employee alex --token xoxb-...
 */
import 'reflect-metadata';

import { AppDataSource } from './data-source';
import { registerPuppet } from './puppet-identity';

function parseArgs(): { team: string; employee: string; token: string } {
  const args = process.argv.slice(2);
  const get = (flag: string): string | undefined => {
    const idx = args.indexOf(flag);
    return idx !== -1 ? args[idx + 1] : undefined;
  };
  const team = get('--team');
  const employee = get('--employee');
  const token = get('--token');
  if (!team || !employee || !token) {
    console.error('Usage: pnpm puppet:register --team <T0...> --employee <botId> --token <xoxb-...>');
    process.exit(1);
  }
  return { team, employee, token };
}

async function main(): Promise<void> {
  const { team, employee, token } = parseArgs();
  await AppDataSource.initialize();
  try {
    const { slackBotUserId } = await registerPuppet(AppDataSource, {
      team,
      botId: employee,
      token,
    });
    console.log(`✓ ${employee} registered for ${team} (bot user: ${slackBotUserId})`);
  } finally {
    await AppDataSource.destroy();
  }
}

void main().catch((err) => {
  console.error(err);
  process.exit(1);
});
