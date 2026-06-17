import type { DescriptionChangeEvent } from '@harness/approvals/board-notifier.port';
import type { PlanProposalEvent } from '@harness/approvals/proposal-presenter.port';
import type { SlackInbound } from '../slack-inbound.types';
import {
  APPROVE_ACTION_ID,
  DENY_ACTION_ID,
  REQUEST_CHANGES_ACTION_ID,
  REVISION_MODAL_CALLBACK_ID,
  chunkPlan,
  descriptionChangeCardBlocks,
} from './approval-blocks';
import { ApprovalCardsService } from './approval-cards.service';

/**
 * Both directions of the proposal port's Slack adapter, against a mock WebClient: the card post
 * (outbound) and the verdict ingestion (inbound) — boss check fail-closed, CAS-guarded board
 * transitions, the ticket note, the card repaint, and the SILENT lead wake-up via
 * conductor.injectSeed (the session-relay pattern — no synthesized channel message).
 */

const EVENT: PlanProposalEvent = {
  team: 'T1',
  taskId: 7,
  title: 'Wire the API',
  summary: 'One summary to rule them all.',
  proposedBy: 'atlas',
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
  /** Make the app's snippet upload reject (e.g. missing files:write scope). */
  uploadFails?: boolean;
}) {
  const web = {
    chat: {
      postMessage: vi.fn(() => Promise.resolve({ ok: true, ts: '111.222' })),
      postEphemeral: vi.fn(() => Promise.resolve({ ok: true })),
      update: vi.fn(() => Promise.resolve({ ok: true })),
    },
    views: { open: vi.fn(() => Promise.resolve({ ok: true })) },
    filesUploadV2: vi.fn(() =>
      opts.uploadFails
        ? Promise.reject(new Error('missing_scope'))
        : Promise.resolve({ ok: true }),
    ),
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
          : { id: 7, status: 'approved', createdBy: 'atlas' },
      ),
    ),
    get: vi.fn(() => Promise.resolve({ id: 7, status: 'approved' })),
  };
  const notes = { add: vi.fn(() => Promise.resolve({ id: 1 })) };
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

/** A zero-arg vi.fn()'s `calls` is typed `[][]` — widen to read the runtime-recorded args. */
const argsOf = (m: { mock: { calls: unknown[][] } }): unknown[][] =>
  m.mock.calls;

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
  it('posts the card AS the proposing lead (username override, main app) and uploads each plan as a .md snippet in its thread', async () => {
    const { service, web } = makeService({ installedBy: 'U-BOSS' });
    await service.present(EVENT);

    // ONE chat message — the card, posing as Atlas through the MAIN app (block_actions route to
    // the posting app, so the card must be app-posted for button interactivity).
    const posts = argsOf(web.chat.postMessage).map(
      (c) => c[0] as Record<string, unknown>,
    );
    expect(posts).toHaveLength(1);
    expect(posts[0]).toMatchObject({ channel: 'C42', username: 'Atlas' });
    expect(JSON.stringify(posts[0].blocks)).toContain('Wire the API');
    expect(JSON.stringify(posts[0].blocks)).toContain(APPROVE_ACTION_ID);

    // Plans ride as markdown snippets in the card's thread.
    const uploads = argsOf(web.filesUploadV2).map(
      (c) => c[0] as Record<string, unknown>,
    );
    expect(uploads).toHaveLength(2);
    expect(uploads[0]).toMatchObject({
      channel_id: 'C42',
      thread_ts: '111.222',
      filename: 'ticket-7-alex-plan.md',
      content: 'alex plan body',
    });
    expect(uploads[1]).toMatchObject({ filename: 'ticket-7-riley-plan.md' });
  });

  it('falls back to chunked thread messages when snippet uploads fail (e.g. missing files:write)', async () => {
    const { service, web } = makeService({
      installedBy: 'U-BOSS',
      uploadFails: true,
    });
    await service.present(EVENT);
    const posts = argsOf(web.chat.postMessage).map(
      (c) => c[0] as Record<string, unknown>,
    );
    expect(posts).toHaveLength(3); // card + 2 fallback text plans
    expect(posts[1]).toMatchObject({ thread_ts: '111.222' });
    expect(posts[1].text).toContain("*alex's plan*");
    expect(posts[2].text).toContain("*riley's plan*");
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
    const update = argsOf(web.chat.update)[0][0] as Record<string, unknown>;
    expect(update).toMatchObject({ channel: 'C42', ts: '111.222' });
    const updatedBlocks = JSON.stringify(update.blocks);
    expect(updatedBlocks).toContain('✅ Approved by');
    expect(updatedBlocks).not.toContain('"actions"'); // buttons stripped
    // The lead is woken SILENTLY (session-relay pattern) — no synthesized channel message.
    expect(conductor.injectSeed).toHaveBeenCalledWith(
      'atlas',
      'slack:T1:C42',
      expect.stringContaining('Dennis APPROVED ticket #7'),
    );
    expect(argsOf(conductor.injectSeed)[0][2] as string).toContain(
      'silent heads-up',
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
    expect(conductor.injectSeed).toHaveBeenCalledWith(
      'atlas',
      'slack:T1:C42',
      expect.stringContaining('DENIED ticket #7'),
    );
  });

  it('a stale/double-clicked card loses the CAS: ephemeral only, no note, no repaint, no message', async () => {
    const { service, web, notes, conductor } = makeService({
      installedBy: 'U-BOSS',
      transitionResult: undefined,
    });
    await service.maybeHandle(click(APPROVE_ACTION_ID));
    const ephemeral = argsOf(web.chat.postEphemeral)[0][0] as {
      text: string;
    };
    expect(ephemeral.text).toContain("already ruled on (now 'approved')");
    expect(notes.add).not.toHaveBeenCalled();
    expect(web.chat.update).not.toHaveBeenCalled();
    expect(conductor.injectSeed).not.toHaveBeenCalled();
  });

  it('request changes: opens the modal (no board write), and the submission applies the verdict with the notes', async () => {
    const { service, web, board, conductor } = makeService({
      installedBy: 'U-BOSS',
      transitionResult: { id: 7, status: 'in_progress' },
    });
    await service.maybeHandle(click(REQUEST_CHANGES_ACTION_ID));
    expect(board.transition).not.toHaveBeenCalled();
    const view = (argsOf(web.views.open)[0][0] as Record<string, unknown>)
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
        status: 'planning',
      },
    );
    expect(conductor.injectSeed).toHaveBeenCalledWith(
      'atlas',
      'slack:T1:C42',
      expect.stringContaining('use Postgres, not MySQL'),
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

// ── descriptionChangeCardBlocks (approval-blocks) ────────────────────────────────────────────────

const CHANGE_EVENT: DescriptionChangeEvent = {
  team: 'T1',
  taskId: 26,
  title: 'Wire the API',
  changedBy: 'atlas',
  oldDescription: 'Original description.',
  newDescription: 'Updated description.',
  surfaceId: 'slack:T1:C99',
};

describe('descriptionChangeCardBlocks', () => {
  it('headline contains ticket id and title', () => {
    const blocks = descriptionChangeCardBlocks(CHANGE_EVENT);
    const json = JSON.stringify(blocks);
    expect(json).toContain('ticket #26');
    expect(json).toContain('Wire the API');
  });

  it('includes changedBy in the context line', () => {
    const blocks = descriptionChangeCardBlocks(CHANGE_EVENT);
    const json = JSON.stringify(blocks);
    expect(json).toContain('Changed by atlas');
  });

  it('includes the @mention when bossMention is supplied', () => {
    const blocks = descriptionChangeCardBlocks(CHANGE_EVENT, '<@U-BOSS>');
    const json = JSON.stringify(blocks);
    expect(json).toContain('<@U-BOSS>');
  });

  it('omits bossMention gracefully when not supplied', () => {
    const blocks = descriptionChangeCardBlocks(CHANGE_EVENT);
    const json = JSON.stringify(blocks);
    expect(json).not.toContain('<@');
  });

  it('shows old and new description text', () => {
    const blocks = descriptionChangeCardBlocks(CHANGE_EVENT);
    const json = JSON.stringify(blocks);
    expect(json).toContain('Original description.');
    expect(json).toContain('Updated description.');
    expect(json).toContain('Old description');
    expect(json).toContain('New description');
  });

  it('has no actions block (purely informational, no buttons)', () => {
    const blocks = descriptionChangeCardBlocks(CHANGE_EVENT, '<@U-BOSS>');
    expect(blocks.every((b) => b.type !== 'actions')).toBe(true);
  });

  it('truncates descriptions that exceed SUMMARY_MAX (~2900 chars)', () => {
    const huge = 'x'.repeat(4000);
    const blocks = descriptionChangeCardBlocks(
      { ...CHANGE_EVENT, oldDescription: huge, newDescription: huge },
      '<@U-BOSS>',
    );
    const json = JSON.stringify(blocks);
    // The truncated marker must appear for both sections.
    expect(json).toContain('…(truncated)');
    // The raw 4000-char string must NOT appear verbatim.
    expect(json).not.toContain(huge);
  });
});

// ── ApprovalCardsService.notifyDescriptionChange ──────────────────────────────────────────────────

describe('ApprovalCardsService — notifyDescriptionChange', () => {
  it('posts to the parsed channel with @boss mention and both descriptions', async () => {
    const { service, web } = makeService({ installedBy: 'U-BOSS' });
    await service.notifyDescriptionChange(CHANGE_EVENT);

    const posts = argsOf(web.chat.postMessage).map(
      (c) => c[0] as Record<string, unknown>,
    );
    expect(posts).toHaveLength(1);
    expect(posts[0]).toMatchObject({ channel: 'C99', username: 'Atlas' });
    const text = posts[0].text as string;
    expect(text).toContain('<@U-BOSS>');
    const blocksJson = JSON.stringify(posts[0].blocks);
    expect(blocksJson).toContain('Original description.');
    expect(blocksJson).toContain('Updated description.');
    expect(blocksJson).toContain('<@U-BOSS>');
  });

  it("degrades to literal 'Dennis' when no boss id is configured", async () => {
    const { service, web } = makeService({ installedBy: null });
    await service.notifyDescriptionChange(CHANGE_EVENT);

    const posts = argsOf(web.chat.postMessage).map(
      (c) => c[0] as Record<string, unknown>,
    );
    expect(posts).toHaveLength(1);
    const blocksJson = JSON.stringify(posts[0].blocks);
    // No <@ mention, but the literal fallback appears.
    expect(blocksJson).toContain('Dennis');
    expect(blocksJson).not.toContain('<@');
  });

  it('uses the env fallback boss id when installedBy is null', async () => {
    const { service, web } = makeService({
      installedBy: null,
      envBoss: 'U-ENV-BOSS',
    });
    await service.notifyDescriptionChange(CHANGE_EVENT);

    const posts = argsOf(web.chat.postMessage).map(
      (c) => c[0] as Record<string, unknown>,
    );
    expect(JSON.stringify(posts[0].blocks)).toContain('<@U-ENV-BOSS>');
  });

  it('throws (and does NOT post) for a non-Slack surface id', async () => {
    const { service, web } = makeService({ installedBy: 'U-BOSS' });
    await expect(
      service.notifyDescriptionChange({
        ...CHANGE_EVENT,
        surfaceId: 'tui:main',
      }),
    ).rejects.toThrow('non-Slack');
    expect(web.chat.postMessage).not.toHaveBeenCalled();
  });
});
