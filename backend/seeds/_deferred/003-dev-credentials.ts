import type { Seeder } from '@workspace/nestjs-core';
import { isNewerCodexAuth } from '../../src/app_old/onboarding/codex-auth-freshness';
import {
  decryptSecret,
  encryptSecret,
  loadSecretsKey,
} from '../../src/app_old/onboarding/secret-cipher';
import {
  OrgClaudeCredentialEntity,
  OrgCredentialsEntity,
  OrganizationEntity,
} from '../../src/app_old/persistence/entities';
import { DEV_SEED_IDS } from '../_shared/dev-seed-ids';

/**
 * Dev credentials for the seeded org — writes the encrypted `org_credentials` row (`scope='*'`) for the
 * `001` org so a fresh `pnpm db:seed` yields an org that can actually run Claude/Codex turns + git ops
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

  if (!anthropicApiKey && !openaiApiKey && !githubPat && !claudeOauthToken && !codexAuthSecret) {
    console.log('  003: no credentials in env (.env.seed.enc not layered?) — skipping');
    return;
  }

  const creds = ds.getRepository(OrgCredentialsEntity);
  const orgIds = [DEV_SEED_IDS.orgs.atlasTest];

  for (const orgId of orgIds) {
    const row =
      (await creds.findOne({ where: { org_id: orgId, scope: '*' } })) ??
      creds.create({ org_id: orgId, scope: '*' });

    // Four static creds: overwrite straight from the file when provided.
    if (anthropicApiKey) {
      row.anthropic_api_key_enc = encryptSecret(anthropicApiKey, key);
      // Stamp the key as validated so the onboarding checklist's `llmKey` step (which requires
      // `hasAnthropic && llm_validated_at`) passes — a seeded dev key is trusted, exactly as the
      // real validate flow stamps it. Without this the org shows "finish org setup" despite the key.
      row.llm_validated_at = new Date();
    }
    if (openaiApiKey) row.openai_api_key_enc = encryptSecret(openaiApiKey, key);
    if (githubPat) row.github_pat_enc = encryptSecret(githubPat, key);

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

    // Claude auth lives in the new `claude_credentials` table (the resolver reads ONLY the org's selected
    // row — the legacy `org_credentials.claude_oauth_token_enc` column is vestigial and no longer read).
    // Upsert ONE canonical "Imported setup-token" row and select it, mirroring the runtime write-through
    // (`ClaudeCredentialStore.upsertLegacySetupToken`) + the migration's imported label so re-seeds don't
    // accumulate duplicates and the seeded org can actually authenticate a Claude turn.
    if (claudeOauthToken) {
      const LEGACY_SETUP_TOKEN_LABEL = 'Imported setup-token';
      const claudeCreds = ds.getRepository(OrgClaudeCredentialEntity);
      const cred =
        (await claudeCreds.findOne({
          where: {
            org_id: orgId,
            kind: 'setup_token',
            label: LEGACY_SETUP_TOKEN_LABEL,
          },
        })) ??
        claudeCreds.create({
          org_id: orgId,
          label: LEGACY_SETUP_TOKEN_LABEL,
          kind: 'setup_token',
          refresh_token_enc: null,
          expires_at: null,
          status: 'active',
        });
      cred.access_token_enc = encryptSecret(claudeOauthToken, key);
      const savedCred = await claudeCreds.save(cred);
      await ds
        .getRepository(OrganizationEntity)
        .update({ id: orgId }, { selected_claude_credential_id: savedCred.id });
    }

    console.log(`  003: seeded credentials for org ${orgId}`);
  }
}) satisfies Seeder;
