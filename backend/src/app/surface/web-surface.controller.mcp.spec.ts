import { BadRequestException } from '@nestjs/common';
import { GUARDS_METADATA } from '@nestjs/common/constants';
import { describe, expect, it, vi } from 'vitest';
import type { CurrentOrgCtx } from '../org/current-org.decorator';
import { OrgOwnerGuard } from '../org/org-owner.guard';
import { WebSurfaceController } from './web-surface.controller';

/**
 * The onboarding-brain MCP path on the web surface: the owner-gated `mcp-proposals/:id/approve` endpoint
 * (the ONLY place a brain-authored MCP write lands) and the `provide-secret` MCP-target lane. Pure unit —
 * the controller is built with mocked collaborators; guards are asserted via route metadata (they are the
 * enforcement boundary, applied by Nest, not exercised in a direct method call).
 */
type Mocks = {
  seedSystemNotification: ReturnType<typeof vi.fn>;
  getMcpProposalCard: ReturnType<typeof vi.fn>;
  markMcpProposalApproved: ReturnType<typeof vi.fn>;
  clearAwaitingSecret: ReturnType<typeof vi.fn>;
  write: ReturnType<typeof vi.fn>;
  rawRow: ReturnType<typeof vi.fn>;
  recordValidation: ReturnType<typeof vi.fn>;
  setSecret: ReturnType<typeof vi.fn>;
  del: ReturnType<typeof vi.fn>;
  validate: ReturnType<typeof vi.fn>;
  rehydrateThread: ReturnType<typeof vi.fn>;
  messages: { findOne: ReturnType<typeof vi.fn>; save: ReturnType<typeof vi.fn> };
};

function makeController(opts?: { threadRepoId?: string; card?: unknown; secretCard?: unknown }) {
  const threadRepoId = opts?.threadRepoId ?? 'repo-1';
  const m: Mocks = {
    seedSystemNotification: vi.fn(() => 'ts-1'),
    getMcpProposalCard: vi.fn(async () => opts?.card ?? null),
    markMcpProposalApproved: vi.fn(async () => undefined),
    clearAwaitingSecret: vi.fn(async () => undefined),
    write: vi.fn(async () => undefined),
    rawRow: vi.fn(async () => ({ transport: 'http', config: { url: 'https://x' } })),
    recordValidation: vi.fn(async () => undefined),
    setSecret: vi.fn(async () => true),
    del: vi.fn(async () => undefined),
    validate: vi.fn(async () => ({ discoveredTools: ['t'] })),
    rehydrateThread: vi.fn(async () => undefined),
    messages: {
      findOne: vi.fn(async () => (opts?.secretCard ? { card: opts.secretCard } : null)),
      save: vi.fn(async () => undefined),
    },
  };
  const threads = {
    findOne: vi.fn(async ({ where }: { where: { id: string; org_id: string } }) => ({
      id: where.id,
      org_id: where.org_id,
      repo_id: threadRepoId,
      awaiting_secret_id: 's-1',
    })),
  };
  const controller = new WebSurfaceController(
    { seedSystemNotification: m.seedSystemNotification, name: 'web' } as never, // surface
    {} as never, // liveTurns
    {} as never, // driverStore
    { rehydrateThread: m.rehydrateThread } as never, // threadLifecycle
    {} as never, // orgService
    threads as never,
    m.messages as never,
    {} as never, // repos
    {} as never, // threadTitle
    {} as never, // ticketEvents
    {} as never, // usageBus
    { available: false } as never, // realtime
    {} as never, // election
    { dispatch: async () => undefined } as never, // dispatcher
    { write: async () => undefined } as never, // secrets
    {
      getMcpProposalCard: m.getMcpProposalCard,
      markMcpProposalApproved: m.markMcpProposalApproved,
      clearAwaitingSecret: m.clearAwaitingSecret,
    } as never, // store (BrainStoreService)
    {} as never, // brain
    {
      write: m.write,
      rawRow: m.rawRow,
      recordValidation: m.recordValidation,
      setSecret: m.setSecret,
      delete: m.del,
    } as never, // mcpStore
    { validate: m.validate } as never, // mcpProbe
    {} as never, // conventions (ConventionProfileResolver)
    {} as never, // skillStore (WorkspaceSkillStore)
    {} as never, // skillFiles (SkillFileWriter)
    {} as never, // skillInstaller (SkillInstallerService)
    {} as never, // git (LocalGitService)
  );
  return { controller, m };
}

const OWNER: CurrentOrgCtx = { id: 'orgA', role: 'owner' };

describe('WebSurfaceController — MCP proposal approve (owner-gated commit)', () => {
  it('is guarded by OrgOwnerGuard (owner-only Administer action)', () => {
    const guards = Reflect.getMetadata(
      GUARDS_METADATA,
      WebSurfaceController.prototype.approveMcpProposal,
    ) as unknown[];
    expect(guards).toContain(OrgOwnerGuard);
  });

  it('commits each server on the card scope (defaults to the thread repo) + marks approved', async () => {
    const card = {
      type: 'mcp_proposal_card',
      servers: [
        {
          name: 'github',
          transport: 'http',
          url: 'https://api.githubcopilot.com/mcp/',
          headers: [{ name: 'Authorization', secret: true }],
        },
        { name: 'deepwiki', transport: 'http', url: 'https://mcp.deepwiki.com/mcp' },
      ],
    };
    const { controller, m } = makeController({ threadRepoId: 'repo-1', card });
    const res = await controller.approveMcpProposal(OWNER, 'job-1', 'mcp-1');

    expect(res).toMatchObject({ ok: true, committed: ['github', 'deepwiki'] });
    // No scope on the card ⇒ defaults to the thread's repo for every write.
    expect(m.write).toHaveBeenCalledTimes(2);
    for (const call of m.write.mock.calls) {
      expect(call[0]).toBe('orgA'); // orgId
      expect(call[1]).toBe('repo-1'); // dbScope = thread.repo_id
    }
    // github's Authorization is committed as an EMPTY secret placeholder (value collected later).
    const githubInput = m.write.mock.calls.find((c) => c[2] === 'github')![3];
    expect(githubInput.headers).toEqual([{ name: 'Authorization', value: '', secret: true }]);
    // deepwiki has no secret slot → probed now so its tool list populates; github (secret) is NOT probed.
    expect(m.validate).toHaveBeenCalledTimes(1);
    expect(m.markMcpProposalApproved).toHaveBeenCalledWith('job-1', 'mcp-1', ['github', 'deepwiki']);
  });

  it('commits ORG-wide (the "*" sentinel) when the card scope is "org"', async () => {
    const card = {
      type: 'mcp_proposal_card',
      scope: 'org',
      servers: [{ name: 'linear', transport: 'http', url: 'https://mcp.linear.app/sse' }],
    };
    const { controller, m } = makeController({ threadRepoId: 'repo-1', card });
    await controller.approveMcpProposal(OWNER, 'job-1', 'mcp-1');
    expect(m.write.mock.calls[0][1]).toBe('*'); // dbScope = org sentinel, not repo-1
  });

  it('removal card (mode:remove) DELETES the named servers on the card scope', async () => {
    const card = {
      type: 'mcp_proposal_card',
      scope: 'org',
      mode: 'remove',
      removeNames: ['linear', 'deepwiki'],
      servers: [],
    };
    const { controller, m } = makeController({ threadRepoId: 'repo-1', card });
    const res = await controller.approveMcpProposal(OWNER, 'job-1', 'mcp-1');
    expect(res).toMatchObject({ ok: true, committed: ['linear', 'deepwiki'] });
    expect(m.del).toHaveBeenCalledTimes(2);
    expect(m.del.mock.calls.map((c) => [c[1], c[2]])).toEqual([
      ['*', 'linear'],
      ['*', 'deepwiki'],
    ]);
    expect(m.write).not.toHaveBeenCalled(); // a removal never writes
  });

  it('an oauth server is committed with authKind, NOT static-probed, and the notice points to Connect', async () => {
    const card = {
      type: 'mcp_proposal_card',
      servers: [
        { name: 'jira', transport: 'sse', url: 'https://mcp.atlassian.com/v1/sse', authKind: 'oauth' },
      ],
    };
    const { controller, m } = makeController({ threadRepoId: 'repo-1', card });
    const res = await controller.approveMcpProposal(OWNER, 'job-1', 'mcp-1');

    expect(res).toMatchObject({ ok: true, committed: ['jira'] });
    // mcpProposalToInput carries authKind → the store writes an oauth row.
    const jiraInput = m.write.mock.calls.find((c) => c[2] === 'jira')![3];
    expect(jiraInput.authKind).toBe('oauth');
    // An UNCONNECTED oauth server must NOT be static-probed (its endpoint 401s until the owner connects).
    expect(m.validate).not.toHaveBeenCalled();
    const notice = m.seedSystemNotification.mock.calls.at(-1)![2] as string;
    expect(notice).toContain('Connect');
    expect(notice).not.toContain('No secrets needed'); // the static "ready" copy must not fire for oauth
  });

  it('is idempotent — a re-approve of an already-committed card writes nothing', async () => {
    const card = {
      type: 'mcp_proposal_card',
      approved_at: '2026-07-07T00:00:00Z',
      committed: ['github'],
      servers: [{ name: 'github', transport: 'http', url: 'https://x' }],
    };
    const { controller, m } = makeController({ card });
    const res = await controller.approveMcpProposal(OWNER, 'job-1', 'mcp-1');
    expect(res).toMatchObject({ ok: true, committed: ['github'] });
    expect(m.write).not.toHaveBeenCalled();
  });

  it('404s (BadRequest) when there is no such proposal on the thread', async () => {
    const { controller } = makeController({ card: null });
    await expect(controller.approveMcpProposal(OWNER, 'job-1', 'nope')).rejects.toBeInstanceOf(
      BadRequestException,
    );
  });

  it('defensively skips a reserved system name even if a stale card carries one', async () => {
    const card = {
      type: 'mcp_proposal_card',
      servers: [
        { name: 'context7', transport: 'http', url: 'https://x' },
        { name: 'deepwiki', transport: 'http', url: 'https://y' },
      ],
    };
    const { controller, m } = makeController({ card });
    const res = await controller.approveMcpProposal(OWNER, 'job-1', 'mcp-1');
    expect(res.committed).toEqual(['deepwiki']);
    expect(m.write).toHaveBeenCalledTimes(1);
  });
});

describe('WebSurfaceController — provide-secret MCP-target lane', () => {
  it('writes the value into the MCP store (mapped slot), skips rehydrate, re-probes, masks the notice', async () => {
    const secretCard = {
      type: 'secret_input_card',
      name: 'Authorization',
      mcp: { server: 'github', slot: 'header', key: 'Authorization' },
    };
    const { controller, m } = makeController({ secretCard });
    const res = await controller.provideSecret(OWNER, 'job-1', {
      requestId: 's-1',
      value: 'Bearer ghp_x',
    });

    expect(res).toMatchObject({ ok: true });
    // 'header' maps to the store's 'headers' slot; scope is the thread repo.
    expect(m.setSecret).toHaveBeenCalledWith('orgA', 'repo-1', 'github', 'headers', 'Authorization', 'Bearer ghp_x');
    // MCP secrets are resolved per-turn → no worktree rehydration.
    expect(m.rehydrateThread).not.toHaveBeenCalled();
    // Best-effort re-probe after the key lands.
    expect(m.validate).toHaveBeenCalledTimes(1);
    // The masked confirmation names the server/slot, never the value.
    const notice = m.seedSystemNotification.mock.calls.at(-1)![2] as string;
    expect(notice).toContain('github');
    expect(notice).not.toContain('ghp_x');
  });

  it('refuses a secret write to an OAuth server (no setSecret, no probe) and clears the gate', async () => {
    const secretCard = {
      type: 'secret_input_card',
      name: 'Authorization',
      mcp: { server: 'jira', slot: 'header', key: 'Authorization' },
    };
    const { controller, m } = makeController({ secretCard });
    // The target row is an oauth server — the authoritative guard must refuse before setSecret.
    m.rawRow.mockResolvedValueOnce({ auth_kind: 'oauth', transport: 'sse', config: { url: 'https://x' } });
    const res = await controller.provideSecret(OWNER, 'job-1', { requestId: 's-1', value: 'Bearer x' });

    expect(res.ok).toBe(false);
    expect(m.setSecret).not.toHaveBeenCalled();
    expect(m.validate).not.toHaveBeenCalled();
    expect(m.clearAwaitingSecret).toHaveBeenCalledWith('job-1', 's-1');
    const notice = m.seedSystemNotification.mock.calls.at(-1)![2] as string;
    expect(notice).toContain('OAuth');
    expect(notice).not.toContain('Bearer x');
  });

  it('clears the gate + fails cleanly when the target MCP server is gone', async () => {
    const secretCard = {
      type: 'secret_input_card',
      name: 'Authorization',
      mcp: { server: 'github', slot: 'header', key: 'Authorization' },
    };
    const { controller, m } = makeController({ secretCard });
    m.setSecret.mockResolvedValueOnce(false);
    const res = await controller.provideSecret(OWNER, 'job-1', { requestId: 's-1', value: 'v' });
    expect(res.ok).toBe(false);
    expect(m.clearAwaitingSecret).toHaveBeenCalledWith('job-1', 's-1');
  });
});
