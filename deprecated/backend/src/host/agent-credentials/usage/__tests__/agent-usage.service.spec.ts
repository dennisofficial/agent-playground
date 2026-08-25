import type { PrismaService } from '@lib/prisma/prisma.service';
import { EAgentCredentialKind, EAgentProvider } from '@workspace/shared';
import { describe, expect, it, vi } from 'vitest';
import type { AgentCredential } from '../../../../generated/prisma/client';
import type { AgentCredentialRefreshService } from '../../agent-credential-refresh.service';
import type { AgentCredentialService } from '../../agent-credential.service';
import { AgentUsageService } from '../agent-usage.service';
import { UsageParseService } from '../usage-parse.service';

const usage = { fiveHour: null, ok: false } as const;

function harness(kind: EAgentCredentialKind) {
  const ensureFresh = vi.fn(async () => 'material');
  const row = { id: 'cred-1', provider: EAgentProvider.CLAUDE, kind } as unknown as AgentCredential;
  const service = new AgentUsageService(
    {} as unknown as PrismaService,
    {
      getById: vi.fn(async () => row),
      toView: vi.fn(() => ({ usage })),
    } as unknown as AgentCredentialService,
    { ensureFresh } as unknown as AgentCredentialRefreshService,
    new UsageParseService(),
  );
  return { service, ensureFresh };
}

describe('AgentUsageService.pollClaudeUsage', () => {
  // A setup token carries `user:inference` only; /api/oauth/usage answers 403 "does not meet scope
  // requirement user:profile". Spending the request to rediscover that every poll is pure noise.
  it('short-circuits a setup-token account without touching the usage API', async () => {
    const { service, ensureFresh } = harness(EAgentCredentialKind.SETUP_TOKEN);

    await expect(service.pollClaudeUsage('org-1', 'cred-1')).resolves.toBe(usage);
    expect(ensureFresh).not.toHaveBeenCalled();
  });

  it('still resolves material for a personal (OAuth) account', async () => {
    const { service, ensureFresh } = harness(EAgentCredentialKind.PERSONAL);

    await service.pollClaudeUsage('org-1', 'cred-1');
    expect(ensureFresh).toHaveBeenCalledWith('org-1', 'cred-1');
  });
});
