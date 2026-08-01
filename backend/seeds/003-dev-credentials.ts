import type { Seeder } from '@dltech/nestjs-core';
import { EAgentCredentialKind, EAgentCredentialStatus, EAgentProvider } from '@workspace/shared';
import type { Repository } from 'typeorm';
import { EnvService } from '../src/_core/config/env/env.service';
import { SecretCipherService } from '../src/_lib/crypto/secret-cipher.service';
import { AgentCredential } from '../src/_lib/database/entities/agent-credential.entity';
import { OrgCredential } from '../src/_lib/database/entities/org-credential.entity';
import { DEV_SEED_IDS } from './_shared/dev-seed-ids';

const CLAUDE_SETUP_TOKEN_LABEL = 'Dev seed setup-token';

export default (async (ds) => {
  const key = process.env.SECRETS_ENCRYPTION_KEY;
  if (!key) {
    console.log('  003: SECRETS_ENCRYPTION_KEY not set — skipping dev credentials');
    return;
  }
  // Reuse the runtime cipher so seeded ciphertext is byte-identical to what the app writes. The service
  // only reads SECRETS_ENCRYPTION_KEY off EnvService, so a minimal process.env-backed shim suffices.
  const cipher = new SecretCipherService({
    get: (k: string) => process.env[k],
  } as unknown as EnvService);

  const anthropicApiKey = process.env.ANTHROPIC_API_KEY;
  const openaiApiKey = process.env.OPENAI_API_KEY;
  const githubPat = process.env.GITHUB_PAT ?? process.env.GITHUB_TOKEN;
  const claudeSetupToken = process.env.CLAUDE_OAUTH_TOKEN;

  if (!anthropicApiKey && !openaiApiKey && !githubPat && !claudeSetupToken) {
    console.log('  003: no credentials in env (.env.seed.enc not layered?) — skipping');
    return;
  }

  const orgId = DEV_SEED_IDS.orgs.atlasTest;

  // ── org_credentials: raw API keys (one row per org, PK = orgId) ───────────────────────────────────
  if (anthropicApiKey || openaiApiKey || githubPat) {
    const orgCreds = ds.getRepository(OrgCredential);
    const row = (await orgCreds.findOne({ where: { orgId } })) ?? orgCreds.create({ orgId });
    if (anthropicApiKey) row.anthropicApiKeyEnc = cipher.encrypt(anthropicApiKey);
    if (openaiApiKey) row.openaiApiKeyEnc = cipher.encrypt(openaiApiKey);
    if (githubPat) row.githubPatEnc = cipher.encrypt(githubPat);
    await orgCreds.save(row);
    console.log('  003: seeded org_credentials (API keys)');
  }

  // ── Claude: setup-token (non-expiring, non-refreshing) ────────────────────────────────────────────
  if (claudeSetupToken?.trim()) {
    const agentCreds = ds.getRepository(AgentCredential);
    const existing = await agentCreds.findOne({
      where: {
        orgId,
        provider: EAgentProvider.CLAUDE,
        kind: EAgentCredentialKind.SETUP_TOKEN,
        label: CLAUDE_SETUP_TOKEN_LABEL,
      },
    });
    const row =
      existing ??
      agentCreds.create({
        orgId,
        provider: EAgentProvider.CLAUDE,
        kind: EAgentCredentialKind.SETUP_TOKEN,
        label: CLAUDE_SETUP_TOKEN_LABEL,
        accountEmail: null,
        subscriptionType: null,
        scopes: null,
        expiresAt: null,
        status: EAgentCredentialStatus.ACTIVE,
        selected: false,
      });
    row.materialEnc = cipher.encrypt(claudeSetupToken.trim());
    row.status = EAgentCredentialStatus.ACTIVE;
    const saved = await agentCreds.save(row);
    await ensureSelected(agentCreds, orgId, EAgentProvider.CLAUDE, saved.id);
    console.log(`  003: seeded Claude setup-token (${existing ? 'updated' : 'created'})`);
  }
}) satisfies Seeder;

/** Select `fallbackId` only when the (org, provider) pair has no selected account yet. */
async function ensureSelected(
  repo: Repository<AgentCredential>,
  orgId: string,
  provider: EAgentProvider,
  fallbackId: string,
): Promise<void> {
  if (await repo.findOne({ where: { orgId, provider, selected: true } })) return;
  await repo.update({ id: fallbackId }, { selected: true });
}
