import type { TaskSuggestionEvent } from '@harness/approvals/task-suggestion-presenter.port';
import { describe, expect, it, vi } from 'vitest';
import type { SlackInbound } from '../slack-inbound.types';
import {
  SUGGESTION_BACKLOG_ACTION_ID,
  SUGGESTION_DISMISS_ACTION_ID,
  SUGGESTION_RUN_ACTION_ID,
} from './suggestion-blocks';
import { SuggestionCardsService } from './suggestion-cards.service';

/**
 * Both directions of the task-suggestion port's Slack adapter, against a mock WebClient: the chip
 * post (outbound) and the disposition (inbound) — boss check fail-closed, the atomic board write FIRST
 * (claim / dropOpen / no-op), the card repaint, and the SILENT lead wake-up. The invariant under test:
 * a seed only ever fires behind a board write that WON (CAS-then-seed), never on a losing/stale click.
 */

const EVENT: TaskSuggestionEvent = {
  team: 'T1',
  taskId: 7,
  title: 'Add a save offer',
  why: 'reduce churn',
  proposedBy: 'atlas',
  surfaceId: 'slack:T1:C42',
  suggestedDisposition: 'run',
};

function makeService(opts: {
  installedBy?: string | null;
  envBoss?: string;
  claimResult?: unknown;
  dropResult?: unknown;
  getResult?: unknown;
}) {
  const web = {
    chat: {
      postMessage: vi.fn(() => Promise.resolve({ ok: true, ts: '111.222' })),
      postEphemeral: vi.fn(() => Promise.resolve({ ok: true })),
      update: vi.fn(() => Promise.resolve({ ok: true })),
    },
  };
  const clients = { clientFor: vi.fn(() => Promise.resolve(web)) };
  const tenants = {
    get: vi.fn(() =>
      Promise.resolve({
        teamId: 'T1',
        teamName: 'team',
        status: 'active' as const,
        installedBy: opts.installedBy ?? null,
      }),
    ),
  };
  const board = {
    claim: vi.fn(() =>
      Promise.resolve(
        'claimResult' in opts
          ? opts.claimResult
          : { id: 7, title: 'Add a save offer', status: 'planning' },
      ),
    ),
    dropOpen: vi.fn(() =>
      Promise.resolve(
        'dropResult' in opts
          ? opts.dropResult
          : { id: 7, title: 'Add a save offer', status: 'open' },
      ),
    ),
    get: vi.fn(() =>
      Promise.resolve(
        'getResult' in opts
          ? opts.getResult
          : { id: 7, title: 'Add a save offer', status: 'open' },
      ),
    ),
  };
  const conductor = { injectSeed: vi.fn() };
  const employees = {
    teamLead: () => ({ id: 'atlas', name: 'Atlas' }),
    byId: (id: string) =>
      id === 'atlas' ? { id: 'atlas', name: 'Atlas' } : undefined,
  };
  const env = {
    get: (k: string) =>
      k === 'APPROVAL_BOSS_USER_ID' ? opts.envBoss : undefined,
  };
  const service = new SuggestionCardsService(
    clients as never,
    tenants as never,
    board as never,
    conductor as never,
    employees as never,
    env as never,
  );
  return { service, web, board, conductor };
}

const argsOf = (m: { mock: { calls: unknown[][] } }): unknown[][] => m.mock.calls;

const click = (
  actionId: string,
  user = 'U-BOSS',
): Extract<SlackInbound, { kind: 'interactivity' }> => ({
  kind: 'interactivity',
  payload: {
    type: 'block_actions',
    team: { id: 'T1' },
    user: { id: user },
    channel: { id: 'C42' },
    trigger_id: 'trig-1',
    actions: [{ action_id: actionId, value: JSON.stringify({ taskId: 7 }) }],
    message: {
      ts: '111.222',
      blocks: [
        { type: 'section', text: { type: 'mrkdwn', text: 'chip' } },
        { type: 'actions', elements: [] },
      ],
    },
  },
  respond: vi.fn(() => Promise.resolve()),
});

describe('SuggestionCardsService — outbound (present)', () => {
  it('posts the chip AS the suggesting orchestrator (username override, main app) with the buttons', async () => {
    const { service, web } = makeService({ installedBy: 'U-BOSS' });
    await service.present(EVENT);
    const posts = argsOf(web.chat.postMessage).map(
      (c) => c[0] as Record<string, unknown>,
    );
    expect(posts).toHaveLength(1);
    expect(posts[0]).toMatchObject({ channel: 'C42', username: 'Atlas' });
    const blocks = JSON.stringify(posts[0].blocks);
    expect(blocks).toContain('Add a save offer');
    expect(blocks).toContain(SUGGESTION_RUN_ACTION_ID);
    expect(blocks).toContain(SUGGESTION_DISMISS_ACTION_ID);
  });

  it('throws on a non-Slack surface (the tool degrades to chat-words)', async () => {
    const { service, web } = makeService({ installedBy: 'U-BOSS' });
    await expect(
      service.present({ ...EVENT, surfaceId: 'tui:main' }),
    ).rejects.toThrow('non-Slack');
    expect(web.chat.postMessage).not.toHaveBeenCalled();
  });
});

describe('SuggestionCardsService — boss check', () => {
  it('a non-boss click is consumed with an ephemeral, no board write', async () => {
    const { service, web, board } = makeService({ installedBy: 'U-BOSS' });
    expect(
      await service.maybeHandle(click(SUGGESTION_RUN_ACTION_ID, 'U-RANDO')),
    ).toBe(true);
    expect(web.chat.postEphemeral).toHaveBeenCalledWith(
      expect.objectContaining({ user: 'U-RANDO' }),
    );
    expect(board.claim).not.toHaveBeenCalled();
  });

  it('fails CLOSED when installedBy is null and no env fallback', async () => {
    const { service, web, board } = makeService({ installedBy: null });
    await service.maybeHandle(click(SUGGESTION_RUN_ACTION_ID, 'U-BOSS'));
    expect(web.chat.postEphemeral).toHaveBeenCalled();
    expect(board.claim).not.toHaveBeenCalled();
  });
});

describe('SuggestionCardsService — Run now', () => {
  it('claims (open→planning) then repaints and wakes Atlas — CAS, then seed', async () => {
    const { service, web, board, conductor } = makeService({
      installedBy: 'U-BOSS',
    });
    await service.maybeHandle(click(SUGGESTION_RUN_ACTION_ID));
    expect(board.claim).toHaveBeenCalledWith('T1', 7, 'atlas');
    expect(web.chat.update).toHaveBeenCalledOnce();
    expect(conductor.injectSeed).toHaveBeenCalledOnce();
    const [botId, channel, seed] = conductor.injectSeed.mock.calls[0] as [
      string,
      string,
      string,
    ];
    expect(botId).toBe('atlas');
    expect(channel).toBe('slack:T1:C42');
    expect(seed).toMatch(/RUN NOW/);
  });

  it('a losing claim (already picked up) does NOT seed or repaint', async () => {
    const { service, web, conductor } = makeService({
      installedBy: 'U-BOSS',
      claimResult: 'taken',
    });
    await service.maybeHandle(click(SUGGESTION_RUN_ACTION_ID));
    expect(web.chat.postEphemeral).toHaveBeenCalled();
    expect(web.chat.update).not.toHaveBeenCalled();
    expect(conductor.injectSeed).not.toHaveBeenCalled();
  });

  it("a 'missing' row reports it was likely dismissed, no seed", async () => {
    const { service, web, conductor } = makeService({
      installedBy: 'U-BOSS',
      claimResult: 'missing',
    });
    await service.maybeHandle(click(SUGGESTION_RUN_ACTION_ID));
    const eph = argsOf(web.chat.postEphemeral)[0][0] as { text: string };
    expect(eph.text).toMatch(/no longer on the board/);
    expect(conductor.injectSeed).not.toHaveBeenCalled();
  });
});

describe('SuggestionCardsService — Keep in backlog', () => {
  it('is a pure no-op: repaints, no board write, no wake', async () => {
    const { service, web, board, conductor } = makeService({
      installedBy: 'U-BOSS',
    });
    await service.maybeHandle(click(SUGGESTION_BACKLOG_ACTION_ID));
    expect(board.claim).not.toHaveBeenCalled();
    expect(board.dropOpen).not.toHaveBeenCalled();
    expect(web.chat.update).toHaveBeenCalledOnce();
    expect(conductor.injectSeed).not.toHaveBeenCalled();
  });

  it('reports cleanly if the item was meanwhile picked up', async () => {
    const { service, web, conductor } = makeService({
      installedBy: 'U-BOSS',
      getResult: { id: 7, title: 'X', status: 'planning' },
    });
    await service.maybeHandle(click(SUGGESTION_BACKLOG_ACTION_ID));
    expect(web.chat.postEphemeral).toHaveBeenCalled();
    expect(web.chat.update).not.toHaveBeenCalled();
    expect(conductor.injectSeed).not.toHaveBeenCalled();
  });
});

describe('SuggestionCardsService — Dismiss', () => {
  it('prunes (dropOpen) then repaints and wakes Atlas low-key — CAS, then seed', async () => {
    const { service, web, board, conductor } = makeService({
      installedBy: 'U-BOSS',
    });
    await service.maybeHandle(click(SUGGESTION_DISMISS_ACTION_ID));
    expect(board.dropOpen).toHaveBeenCalledWith('T1', 7);
    expect(web.chat.update).toHaveBeenCalledOnce();
    expect(conductor.injectSeed).toHaveBeenCalledOnce();
    expect(conductor.injectSeed.mock.calls[0][2]).toMatch(/DISMISSED/);
  });

  it("a guarded refusal ('has-dependents') does NOT prune-seed or repaint", async () => {
    const { service, web, conductor } = makeService({
      installedBy: 'U-BOSS',
      dropResult: 'has-dependents',
    });
    await service.maybeHandle(click(SUGGESTION_DISMISS_ACTION_ID));
    const eph = argsOf(web.chat.postEphemeral)[0][0] as { text: string };
    expect(eph.text).toMatch(/depends on it/);
    expect(web.chat.update).not.toHaveBeenCalled();
    expect(conductor.injectSeed).not.toHaveBeenCalled();
  });

  it("a 'not-open' row (already picked up) refuses the dismiss, no seed", async () => {
    const { service, conductor } = makeService({
      installedBy: 'U-BOSS',
      dropResult: 'not-open',
    });
    await service.maybeHandle(click(SUGGESTION_DISMISS_ACTION_ID));
    expect(conductor.injectSeed).not.toHaveBeenCalled();
  });
});
