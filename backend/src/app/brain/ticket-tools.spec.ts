import { describe, expect, it, vi } from 'vitest';
import type { ChatStimulus } from '../domain';
import { AgentSessionManager } from './agent-session-manager.service';
import type { TicketService } from '../tickets';

/**
 * The brain's ticket tools must derive org/repo/thread from the stimulus CLOSURE, never from tool args
 * (the cross-tenant safety invariant — same as create_job). These tests build the real tool table and
 * assert the service is always called with the stimulus scope even when the args try to override it.
 */

const STIMULUS: ChatStimulus = {
  kind: 'chat',
  orgId: 'org-REAL',
  repoId: 'repo-REAL',
  jobId: 'thread-REAL',
  author: { id: 'U1', displayName: 'Op' },
  text: 'hi',
  replyRoute: { jobRef: 'thread-REAL' },
} as unknown as ChatStimulus;

function makeManager(tickets: Partial<TicketService>) {
  const store = {
    loadJob: vi.fn().mockResolvedValue({ id: 'thread-REAL', decisionRecordId: 'dr-1', baseBranch: 'main' }),
  };
  const manager = new AgentSessionManager(
    store as never, // store (loadJob)
    {} as never, // driverStore
    {} as never, // memory
    {} as never, // approvals
    {} as never, // lifecycle
    {} as never, // dockerRunner
    { listRunning: async () => [] } as never, // turnRegistry
    {} as never, // planReview
    {} as never, // dispatcher
    {} as never, // surface
    {} as never, // sandboxRows
    {} as never, // stimulusRows
    {} as never, // stimulusStore
    {} as never, // liveTurns
    {} as never, // classifier
    {} as never, // ship
    {} as never, // repos
    {} as never, // awareness
    tickets as TicketService,
    { engineAuth: async () => undefined } as never, // creds
    {
      getState: () => 'leader',
      isLeader: () => true,
      onPromote: () => ({ unsubscribe() {} }),
      onDemote: () => ({ unsubscribe() {} }),
    } as never, // election
    {} as never, // ledger
    {} as never, // manifest
    {} as never, // turnRecovery
    {} as never, // secretStore
    {} as never, // configStore
    {} as never, // git
  );
  return { manager, store };
}

const qualified = (name: string, tools: Record<string, (a: Record<string, unknown>) => Promise<unknown>>) => {
  const key = Object.keys(tools).find((k) => k === name || k.endsWith(`__${name}`));
  if (!key) throw new Error(`tool ${name} not registered`);
  return tools[key];
};

describe('brain ticket tools — closure scoping', () => {
  it('create_ticket uses the stimulus org/repo/thread, ignoring any args that try to override them', async () => {
    const create = vi.fn().mockResolvedValue({ id: 't-1', number: 7 });
    const { manager } = makeManager({ create });
    const tools = manager.buildTools(STIMULUS) as never as Record<string, (a: Record<string, unknown>) => Promise<unknown>>;

    const res = (await qualified('create_ticket', tools)({
      title: 'Editable rename later',
      body: 'do after fixed-at-checkout',
      priority: 'high',
      // hostile overrides — must be ignored:
      orgId: 'org-EVIL',
      repoId: 'repo-EVIL',
      originThreadId: 'thread-EVIL',
    })) as { ok: boolean; number?: number };

    expect(res.ok).toBe(true);
    expect(res.number).toBe(7);
    expect(create).toHaveBeenCalledTimes(1);
    expect(create).toHaveBeenCalledWith(
      expect.objectContaining({
        orgId: 'org-REAL',
        repoId: 'repo-REAL',
        originThreadId: 'thread-REAL',
        originDecisionRecordId: 'dr-1',
        title: 'Editable rename later',
        priority: 'high',
      }),
    );
  });

  it('create_ticket rejects an invalid status without calling the service', async () => {
    const create = vi.fn();
    const { manager } = makeManager({ create });
    const tools = manager.buildTools(STIMULUS) as never as Record<string, (a: Record<string, unknown>) => Promise<unknown>>;
    const res = (await qualified('create_ticket', tools)({ title: 'x', status: 'doing' })) as { ok: boolean };
    expect(res.ok).toBe(false);
    expect(create).not.toHaveBeenCalled();
  });

  it('list_tickets / promote_ticket pass the stimulus scope', async () => {
    const list = vi.fn().mockResolvedValue([]);
    const promote = vi.fn().mockResolvedValue({ jobId: 'th-new', created: true, seedText: '', title: 'X' });
    const { manager } = makeManager({ list, promote });
    const tools = manager.buildTools(STIMULUS) as never as Record<string, (a: Record<string, unknown>) => Promise<unknown>>;

    await qualified('list_tickets', tools)({ status: 'backlog', orgId: 'org-EVIL' });
    expect(list).toHaveBeenCalledWith({ orgId: 'org-REAL', repoId: 'repo-REAL', status: 'backlog' });

    const res = (await qualified('promote_ticket', tools)({ ticketId: 't-9', repoId: 'repo-EVIL' })) as { ok: boolean; jobId?: string };
    expect(res.ok).toBe(true);
    expect(res.jobId).toBe('th-new');
    expect(promote).toHaveBeenCalledWith({ orgId: 'org-REAL', repoId: 'repo-REAL', ticketId: 't-9' });
  });
});
