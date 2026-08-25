import { EnvService } from '../src/_core/config/env/env.service';
import { SecretCipherService } from '../src/_lib/crypto/secret-cipher.service';
import { EAgentCredentialKind, EAgentCredentialStatus, EAgentProvider } from '@workspace/shared';
import type { PrismaClient } from '../src/generated/prisma/client';
import { DEV_SEED_IDS } from './_shared/dev-seed-ids';
import type { Seeder } from './_shared/seeder';

const CLAUDE_SETUP_TOKEN_LABEL = 'Dev seed setup-token';

export default (async (prisma) => {
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
    const data: { anthropicApiKeyEnc?: string; openaiApiKeyEnc?: string; githubPatEnc?: string } = {};
    if (anthropicApiKey) data.anthropicApiKeyEnc = cipher.encrypt(anthropicApiKey);
    if (openaiApiKey) data.openaiApiKeyEnc = cipher.encrypt(openaiApiKey);
    if (githubPat) data.githubPatEnc = cipher.encrypt(githubPat);
    await prisma.orgCredential.upsert({
      where: { orgId },
      create: { orgId, ...data },
      update: data,
    });
    console.log('  003: seeded org_credentials (API keys)');
  }

  // ── Claude: setup-token (non-expiring, non-refreshing) ────────────────────────────────────────────
  if (claudeSetupToken?.trim()) {
    const existing = await prisma.agentCredential.findFirst({
      where: {
        orgId,
        provider: EAgentProvider.CLAUDE,
        kind: EAgentCredentialKind.SETUP_TOKEN,
        label: CLAUDE_SETUP_TOKEN_LABEL,
      },
    });
    const materialEnc = cipher.encrypt(claudeSetupToken.trim());
    const saved = existing
      ? await prisma.agentCredential.update({
          where: { id: existing.id },
          data: { materialEnc, status: EAgentCredentialStatus.ACTIVE },
        })
      : await prisma.agentCredential.create({
          data: {
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
            materialEnc,
          },
        });
    await ensureSelected(prisma, orgId, EAgentProvider.CLAUDE, saved.id);
    console.log(`  003: seeded Claude setup-token (${existing ? 'updated' : 'created'})`);
  }
}) satisfies Seeder;

/** Select `fallbackId` only when the (org, provider) pair has no selected account yet. */
async function ensureSelected(
  prisma: PrismaClient,
  orgId: string,
  provider: EAgentProvider,
  fallbackId: string,
): Promise<void> {
  if (await prisma.agentCredential.findFirst({ where: { orgId, provider, selected: true } })) return;
  await prisma.agentCredential.update({ where: { id: fallbackId }, data: { selected: true } });
}
