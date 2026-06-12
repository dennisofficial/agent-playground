import type { PlanProposalEvent } from '@harness/approvals/proposal-presenter.port';
import type { SlackInbound } from '../slack-inbound.types';
import {
  APPROVE_ACTION_ID,
  DENY_ACTION_ID,
  REQUEST_CHANGES_ACTION_ID,
  REVISION_MODAL_CALLBACK_ID,
  chunkPlan,
} from './approval-blocks';
import { ApprovalCardsService } from './approval-cards.service';

/**
 * Both directions of the proposal port's Slack adapter, against a mock WebClient: the card post
 * (outbound) and the verdict ingestion (inbound) — boss check fail-closed, CAS-guarded board
 * transitions, the ticket note, the card repaint, and the synthesized Dennis message into
 * conductor.submitFrom.
 */

const EVENT: PlanProposalEvent = {
  team: 'T1',
  taskId: 7,
  title: 'Wire the API',
  summary: 'One summary to rule them all.',
  proposedBy: 'sam',
  surfaceId: 'slack:T1:C42',
  plans: [
    { employee: 'alex', planMd: 'alex plan body' },
    { employee: 'riley', planMd: 'riley plan body' },
  ],
};

function makeService(opts: {
  installedBy?: string | null;
  tenantMissing?: boolean;
  envBoss?: string;
  transitionResult?: Record<string, unknown> | undefined;
}) {
  const web = {
    chat: {
      postMessage: vi.fn(() => Promise.resolve({ ok: true, ts: '111.222' })),
      postEphemeral: vi.fn(() => Promise.resolve({ ok: true })),
      update: vi.fn(() => Promise.resolve({ ok: true })),
    },
    views: { open: vi.fn(() => Promise.resolve({ ok: true })) },
  };
  const clients = { clientFor: vi.fn(() => Promise.resolve(web)) };
  const tenants = {
    get: vi.fn(() =>
      Promise.resolve(
        opts.tenantMissing
          ? undefined
          : {
              teamId: 'T1',
              teamName: 'team',
              status: 'active' as const,
              installedBy: opts.installedBy ?? null,
            },
      ),
    ),
  };
  const directory = {
    resolveUser: vi.fn(() =>
      Promise.resolve({ authorId: 'dennis', authorName: 'Dennis' }),
    ),
  };
  const board = {
    transition: vi.fn(() =>
      Promise.resolve(
        'transitionResult' in opts
          ? opts.transitionResult
          : { id: 7, status: 'approved', createdBy: 'sam' },
      ),
    ),
    get: vi.fn(() => Promise.resolve({ id: 7, status: 'approved' })),
  };
  const notes = { add: vi.fn(() => Promise.resolve({ id: 1 })) };
  const conductor = { submitFrom: vi.fn() };
  const employees = { teamLead: () => ({ id: 'sam', name: 'Sam' }) };
  const env = { get: () => opts.envBoss };
  const service = new ApprovalCardsService(
    clients as never,
    tenants as never,
    directory as never,
    board as never,
    notes as never,
    conductor as never,
    employees as never,
    env as never,
  );
  return { service, web, board, notes, conductor };
}

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
        { type: 'section', text: { type: 'mrkdwn', text: 'card' } },
        { type: 'actions', elements: [] },
      ],
    },
  },
  respond: vi.fn(() => Promise.resolve()),
});

describe('ApprovalCardsService — outbound (present)', () => {
  it('posts the card and threads each plan under it', async () => {
    const { service, web } = makeService({ installedBy: 'U-BOSS' });
    await service.present(EVENT);
    const calls = web.chat.postMessage.mock.calls.map(
      (c) => c[0] as Record<string, unknown>,
    );
    expect(calls).toHaveLength(3); // card + 2 single-chunk plans
    expect(calls[0]).toMatchObject({ channel: 'C42' });
    expect(JSON.stringify(calls[0].blocks)).toContain('Wire the API');
    expect(JSON.stringify(calls[0].blocks)).toContain(APPROVE_ACTION_ID);
    expect(calls[1]).toMatchObject({ thread_ts: '111.222' });
    expect(calls[1].text).toContain("*alex's plan*");
    expect(calls[2].text).toContain("*riley's plan*");
  });

  it('throws on a non-Slack surface (the tool degrades to chat-words)', async () => {
    const { service, web } = makeService({ installedBy: 'U-BOSS' });
    await expect(
      service.present({ ...EVENT, surfaceId: 'tui:main' }),
    ).rejects.toThrow('non-Slack');
    expect(web.chat.postMessage).not.toHaveBeenCalled();
  });
});

describe('ApprovalCardsService — boss check', () => {
  it('a non-boss click is consumed with an ephemeral, no board write', async () => {
    const { service, web, board } = makeService({ installedBy: 'U-BOSS' });
    expect(await service.maybeHandle(click(APPROVE_ACTION_ID, 'U-RANDO'))).toBe(
      true,
    );
    expect(web.chat.postEphemeral).toHaveBeenCalledWith(
      expect.objectContaining({ user: 'U-RANDO' }),
    );
    expect(board.transition).not.toHaveBeenCalled();
  });

  it('fails CLOSED when installedBy is null and no env fallback', async () => {
    const { service, board } = makeService({ installedBy: null });
    await service.maybeHandle(click(APPROVE_ACTION_ID, 'U-ANYONE'));
    expect(board.transition).not.toHaveBeenCalled();
  });

  it('the env fallback covers dev workspaces without an OAuth installer', async () => {
    const { service, board } = makeService({
      installedBy: null,
      envBoss: 'U-DEV-DENNIS',
    });
    await service.maybeHandle(click(APPROVE_ACTION_ID, 'U-DEV-DENNIS'));
    expect(board.transition).toHaveBeenCalled();
  });
});

describe('ApprovalCardsService — verdicts', () => {
  it('approve: CAS to approved, note, card repaint, Dennis message @mentions the lead', async () => {
    const { service, web, board, notes, conductor } = makeService({
      installedBy: 'U-BOSS',
    });
    expect(await service.maybeHandle(click(APPROVE_ACTION_ID))).toBe(true);

    expect(board.transition).toHaveBeenCalledWith(
      'T1',
      7,
      'awaiting_approval',
      {
        status: 'approved',
      },
    );
    expect(notes.add).toHaveBeenCalledWith(
      'T1',
      7,
      'dennis',
      expect.stringContaining('Approved the proposal'),
    );
    const update = web.chat.update.mock.calls[0][0] as Record<string, unknown>;
    expect(update).toMatchObject({ channel: 'C42', ts: '111.222' });
    const updatedBlocks = JSON.stringify(update.blocks);
    expect(updatedBlocks).toContain('✅ Approved by');
    expect(updatedBlocks).not.toContain('"actions"'); // buttons stripped
    expect(conductor.submitFrom).toHaveBeenCalledWith(
      'dennis',
      'Dennis',
      expect.stringContaining('@Sam — I approved the proposal for ticket #7'),
      { channelId: 'slack:T1:C42', teamId: 'T1' },
    );
  });

  it('deny: releases to open with assignee cleared', async () => {
    const { service, board, conductor } = makeService({
      installedBy: 'U-BOSS',
      transitionResult: { id: 7, status: 'open' },
    });
    await service.maybeHandle(click(DENY_ACTION_ID));
    expect(board.transition).toHaveBeenCalledWith(
      'T1',
      7,
      'awaiting_approval',
      {
        status: 'open',
        assignee: null,
      },
    );
    expect(conductor.submitFrom).toHaveBeenCalledWith(
      'dennis',
      'Dennis',
      expect.stringContaining('denied the proposal for ticket #7'),
      expect.anything(),
    );
  });

  it('a stale/double-clicked card loses the CAS: ephemeral only, no note, no repaint, no message', async () => {
    const { service, web, notes, conductor } = makeService({
      installedBy: 'U-BOSS',
      transitionResult: undefined,
    });
    await service.maybeHandle(click(APPROVE_ACTION_ID));
    const ephemeral = web.chat.postEphemeral.mock.calls[0][0] as {
      text: string;
    };
    expect(ephemeral.text).toContain("already ruled on (now 'approved')");
    expect(notes.add).not.toHaveBeenCalled();
    expect(web.chat.update).not.toHaveBeenCalled();
    expect(conductor.submitFrom).not.toHaveBeenCalled();
  });

  it('request changes: opens the modal (no board write), and the submission applies the verdict with the notes', async () => {
    const { service, web, board, conductor } = makeService({
      installedBy: 'U-BOSS',
      transitionResult: { id: 7, status: 'in_progress' },
    });
    await service.maybeHandle(click(REQUEST_CHANGES_ACTION_ID));
    expect(board.transition).not.toHaveBeenCalled();
    const view = (web.views.open.mock.calls[0][0] as Record<string, unknown>)
      .view as Record<string, unknown>;
    expect(view.callback_id).toBe(REVISION_MODAL_CALLBACK_ID);
    const meta = JSON.parse(view.private_metadata as string) as Record<
      string,
      unknown
    >;
    expect(meta).toMatchObject({ taskId: 7, channel: 'C42', ts: '111.222' });

    const submission: Extract<SlackInbound, { kind: 'interactivity' }> = {
      kind: 'interactivity',
      payload: {
        type: 'view_submission',
        team: { id: 'T1' },
        user: { id: 'U-BOSS' },
        view: {
          callback_id: REVISION_MODAL_CALLBACK_ID,
          private_metadata: view.private_metadata as string,
          state: {
            values: { notes: { notes: { value: 'use Postgres, not MySQL' } } },
          },
        },
      },
      respond: vi.fn(() => Promise.resolve()),
    };
    expect(await service.maybeHandle(submission)).toBe(true);
    expect(board.transition).toHaveBeenCalledWith(
      'T1',
      7,
      'awaiting_approval',
      {
        status: 'in_progress',
      },
    );
    expect(conductor.submitFrom).toHaveBeenCalledWith(
      'dennis',
      'Dennis',
      expect.stringContaining('use Postgres, not MySQL'),
      expect.anything(),
    );
    expect(submission.respond).toHaveBeenCalled(); // modal closed
  });

  it('foreign action_ids and callback_ids fall through (return false)', async () => {
    const { service } = makeService({ installedBy: 'U-BOSS' });
    expect(await service.maybeHandle(click('jarvis:setup_keys'))).toBe(false);
    const foreignModal: Extract<SlackInbound, { kind: 'interactivity' }> = {
      kind: 'interactivity',
      payload: {
        type: 'view_submission',
        view: { callback_id: 'jarvis:keys' },
      },
      respond: vi.fn(() => Promise.resolve()),
    };
    expect(await service.maybeHandle(foreignModal)).toBe(false);
  });
});

describe('chunkPlan', () => {
  it('splits at line boundaries and caps with a get_ticket pointer', () => {
    const line = 'a line of plan text\n';
    const huge = line.repeat(3000); // ~60k chars → way past the 10-chunk cap
    const chunks = chunkPlan(huge);
    expect(chunks).toHaveLength(10);
    expect(chunks.every((c) => c.length <= 3500 + 80)).toBe(true);
    expect(chunks[9]).toContain('get_ticket');
    expect(chunkPlan('short')).toEqual(['short']);
  });
});
