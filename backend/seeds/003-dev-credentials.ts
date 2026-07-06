import type { Seeder } from '@workspace/nestjs-core';
import { OrgCredentialsEntity } from '../src/app/persistence/entities';
import { isNewerCodexAuth } from '../src/app/onboarding/codex-auth-freshness';
import { decryptSecret, encryptSecret, loadSecretsKey } from '../src/app/onboarding/secret-cipher';
import { DEV_SEED_IDS } from './_shared/dev-seed-ids';

/**
 * Dev credentials for the seeded orgs — writes the encrypted `org_credentials` row (`scope='*'`) for both
 * `001` orgs so a fresh `pnpm db:seed` yields orgs that can actually run Claude/Codex turns + git ops
 * WITHOUT any runtime env fallback (there no longer is one — the resolver reads these rows only). The five
 * secrets come from `.env.seed.enc` (layered into `db:seed` by dotenvx) via `process.env`; the values are
 * never embedded here. Requires `SECRETS_ENCRYPTION_KEY` (same key the runtime decrypts with).
 *
 * Idempotent: the four STATIC creds (Anthropic/OpenAI keys, Claude OAuth token, GitHub PAT) are rewritten
 * from the file each run. The Codex `auth.json` is guarded by the same monotonic `last_refresh` rule the
 * runtime write-back uses (`isNewerCodexAuth`) — so a re-seed after the running app has refreshed the token
 * (the app persists the fresh blob back to this row) NEVER regresses it to the older file blob.
 */
export default (async (ds) => {
  const key = (() => {
    try {
      return loadSecretsKey(process.env.SECRETS_ENCRYPTION_KEY);
    } catch {
      return null;
    }
  })();
  if (!key) {
    console.log('  003: SECRETS_ENCRYPTION_KEY not set — skipping dev credentials');
    return;
  }

  const anthropicApiKey = process.env.ANTHROPIC_API_KEY;
  const openaiApiKey = process.env.OPENAI_API_KEY;
  const githubPat = process.env.GITHUB_PAT ?? process.env.GITHUB_TOKEN;
  const claudeOauthToken = process.env.CLAUDE_OAUTH_TOKEN;
  const codexAuthSecret = process.env.CODEX_OAUTH_TOKEN;

  if (
    !anthropicApiKey &&
    !openaiApiKey &&
    !githubPat &&
    !claudeOauthToken &&
    !codexAuthSecret
  ) {
    console.log('  003: no credentials in env (.env.seed.enc not layered?) — skipping');
    return;
  }

  const creds = ds.getRepository(OrgCredentialsEntity);
  const orgIds = [DEV_SEED_IDS.orgs.hannibal, DEV_SEED_IDS.orgs.cubix];

  for (const orgId of orgIds) {
    const row =
      (await creds.findOne({ where: { org_id: orgId, scope: '*' } })) ??
      creds.create({ org_id: orgId, scope: '*' });

    // Four static creds: overwrite straight from the file when provided.
    if (anthropicApiKey) row.anthropic_api_key_enc = encryptSecret(anthropicApiKey, key);
    if (openaiApiKey) row.openai_api_key_enc = encryptSecret(openaiApiKey, key);
    if (githubPat) row.github_pat_enc = encryptSecret(githubPat, key);
    if (claudeOauthToken) row.claude_oauth_token_enc = encryptSecret(claudeOauthToken, key);

    // Codex auth.json: only (re)write when the file blob is genuinely newer than what's stored, so a
    // re-seed never clobbers a fresher token the running app refreshed back into this row.
    if (codexAuthSecret) {
      const existing = row.codex_auth_secret_enc
        ? decryptSecret(row.codex_auth_secret_enc, key)
        : undefined;
      if (existing === undefined || isNewerCodexAuth(codexAuthSecret, existing)) {
        row.codex_auth_secret_enc = encryptSecret(codexAuthSecret, key);
      }
    }

    await creds.save(row);
    console.log(`  003: seeded credentials for org ${orgId}`);
  }
}) satisfies Seeder;
