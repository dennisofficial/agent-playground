import { BadRequestException, ForbiddenException } from '@nestjs/common';
import { describe, expect, it, vi } from 'vitest';
import type { CurrentOrgCtx } from '../../org/current-org.decorator';
import { WebSurfaceController } from '../web-surface.controller';

/**
 * `POST …/message` — the endpoint applies a batch of staged card answers (question/file/durable-secret)
 * plus an optional operator message. These are pure unit tests: the controller is instantiated with mocked
 * deps, so they exercise the guard/validation/coalescing/dispatch wiring without a DB or brain. See the
 * delivery/stamp integration proofs in `brain/card-gate-delivery-race.int.test.ts` for the one-turn +
 * success-tail behavior.
 */

/** A fresh set of open cards per test — cloned so a per-item `provided_at` stamp doesn't leak across tests. */
function freshCards(): Record<string, Record<string, unknown>> {
  return {
    'q-1': {
      type: 'question_card',
      question: 'Which database?',
      answer: null,
      deliveredAt: null,
      withdrawnAt: null,
    },
    'f-1': {
      type: 'file_request_card',
      path: '.env.keys',
      provided_at: null,
      delivered_at: null,
      withdrawnAt: null,
    },
    's-1': {
      type: 'secret_input_card',
      name: 'API_KEY',
      path: 'secrets/api',
      provided_at: null,
      delivered_at: null,
      withdrawnAt: null,
    },
    's-eph': {
      type: 'secret_input_card',
      name: 'OTP',
      ephemeral: true,
      deliver_to: '/proc/1/fd/0',
      provided_at: null,
      delivered_at: null,
      withdrawnAt: null,
    },
  };
}

function makeController() {
  const cards = freshCards();
  const threads = {
    findOne: vi.fn(async ({ where }: { where: { id: string; org_id: string } }) => ({
      id: where.id,
      org_id: where.org_id,
      repo_id: 'repo-1',
      awaiting_secret_id: null,
    })),
  };
  const messages = {
    findOne: vi.fn(async ({ where }: { where: { ts: string } }) => {
      const card = cards[where.ts];
      return card ? { job_id: 'job-1', ts: where.ts, card } : null;
    }),
    save: vi.fn(async () => undefined),
  };
  const store = {
    markQuestionAnswered: vi.fn(async () => ({ firstAnswer: true })),
    markSecretProvidedPerCard: vi.fn(async () => undefined),
    withdrawSecretRequest: vi.fn(async () => undefined),
  };
  const secrets = { write: vi.fn(async () => undefined) };
  const threadLifecycle = { rehydrateThread: vi.fn(async () => undefined) };
  const seedCalls: Array<{ body: string; opts: Record<string, unknown> }> = [];
  const surface = {
    name: 'web',
    seedSystemNotification: vi.fn(
      (_channel: string, _jobId: string, body: string, opts: Record<string, unknown>) => {
        seedCalls.push({ body, opts });
        return 'ts-batch';
      },
    ),
  };
  const election = { isLeader: () => true };
  const intakeCalls: Array<{ message: unknown; transport: unknown }> = [];
  const composedCalls: Array<{ input: unknown; transport: unknown }> = [];
  const intake = {
    intakeChat: vi.fn(async (message: unknown, transport: unknown) => {
      intakeCalls.push({ message, transport });
    }),
    intakeComposedSeed: vi.fn(async (input: unknown, transport: unknown) => {
      composedCalls.push({ input, transport });
    }),
  };

  const controller = new WebSurfaceController(
    surface as never, // surface
    {} as never, // liveTurns
    {} as never, // driverStore
    threadLifecycle as never, // threadLifecycle
    {} as never, // autoMerge
    {} as never, // orgService
    threads as never, // threads (jobs)
    messages as never, // messages
    {} as never, // repos
    {} as never, // subagents
    {} as never, // threadTitle
    {} as never, // usageBus
    { available: false } as never, // realtime
    election as never, // election
    { dispatch: async () => undefined } as never, // dispatcher
    secrets as never, // secrets
    store as never, // store (BrainStoreService)
    {} as never, // brain
    {} as never, // mcpStore
    {} as never, // mcpProbe
    {} as never, // conventions
    {} as never, // skillStore
    {} as never, // skillFiles
    {} as never, // skillInstaller
    {} as never, // git
    {} as never, // jobDeps
    {} as never, // moduleRef
    intake as never, // intake (StimulusIntake)
  );
  return {
    controller,
    cards,
    store,
    secrets,
    surface,
    seedCalls,
    intake,
    intakeCalls,
    composedCalls,
    threadLifecycle,
  };
}

const owner: CurrentOrgCtx = { id: 'org-1', role: 'owner' };
const member: CurrentOrgCtx = { id: 'org-1', role: 'member' };

describe('WebSurfaceController — /message (card batch, no operator text)', () => {
  it('applies a 3-item batch (question + file + durable secret) as ONE combined seed carrying all three id arrays', async () => {
    const { controller, store, secrets, seedCalls } = makeController();
    const res = await controller.postMessage(owner, {} as never, 'job-1', {
      messages: [
        { type: 'answer_question', questionId: 'q-1', answer: 'Postgres' },
        {
          type: 'file_answered',
          requestId: 'f-1',
          filename: 'keys.env',
          content: 'A=1',
        },
        { type: 'secret_provided', requestId: 's-1', value: 'sk-live-123' },
      ],
    });

    expect(res.ok).toBe(true);
    expect(res.results).toEqual([
      { id: 'q-1', status: 'applied' },
      { id: 'f-1', status: 'applied' },
      { id: 's-1', status: 'applied' },
    ]);
    // Each write happened exactly once. `secrets.write` runs TWICE — once for the file, once for the
    // durable secret (both land in the worktree secret store).
    expect(store.markQuestionAnswered).toHaveBeenCalledOnce();
    expect(secrets.write).toHaveBeenCalledTimes(2);
    expect(store.markSecretProvidedPerCard).toHaveBeenCalledOnce();
    // Exactly ONE combined seed, carrying the three id arrays for the success-tail stamp.
    expect(seedCalls).toHaveLength(1);
    expect(seedCalls[0].opts).toMatchObject({
      deliveredQuestionIds: ['q-1'],
      deliveredFileIds: ['f-1'],
      deliveredSecretIds: ['s-1'],
    });
    expect(seedCalls[0].body).toContain('Postgres');
    expect(seedCalls[0].body).toContain('.env.keys');
    expect(seedCalls[0].body).toContain('API_KEY');
  });

  it('rejects an empty messages array with 400', async () => {
    const { controller } = makeController();
    await expect(
      controller.postMessage(owner, {} as never, 'job-1', { messages: [] }),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('rejects malformed batch items before any per-card write', async () => {
    const { controller, store, secrets } = makeController();
    await expect(
      controller.postMessage(owner, {} as never, 'job-1', {
        messages: [{ type: 'answer_question', questionId: 'q-1', answer: '   ' }],
      }),
    ).rejects.toBeInstanceOf(BadRequestException);
    await expect(
      controller.postMessage(owner, {} as never, 'job-1', {
        messages: [
          {
            type: 'file_answered',
            requestId: 'f-1',
            filename: 'empty.env',
            content: '',
          },
        ],
      }),
    ).rejects.toBeInstanceOf(BadRequestException);
    await expect(
      controller.postMessage(owner, {} as never, 'job-1', {
        messages: [{ type: 'bogus', requestId: 'f-1', content: 'A=1' } as never],
      }),
    ).rejects.toBeInstanceOf(BadRequestException);

    expect(store.markQuestionAnswered).not.toHaveBeenCalled();
    expect(secrets.write).not.toHaveBeenCalled();
  });

  it('a NON-owner member can submit a question-only batch, but is 403d on a batch containing a file or secret item', async () => {
    const { controller, seedCalls } = makeController();
    // Question-only — membership suffices, no 403.
    const ok = await controller.postMessage(member, {} as never, 'job-1', {
      messages: [{ type: 'answer_question', questionId: 'q-1', answer: 'Postgres' }],
    });
    expect(ok.ok).toBe(true);
    expect(seedCalls).toHaveLength(1);

    // A secret item requires owner.
    await expect(
      controller.postMessage(member, {} as never, 'job-1', {
        messages: [{ type: 'secret_provided', requestId: 's-1', value: 'x' }],
      }),
    ).rejects.toBeInstanceOf(ForbiddenException);
    // A file item requires owner.
    await expect(
      controller.postMessage(member, {} as never, 'job-1', {
        messages: [
          {
            type: 'file_answered',
            requestId: 'f-1',
            filename: 'k',
            content: 'A=1',
          },
        ],
      }),
    ).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('an EPHEMERAL-only secret submit applies as a noop and, with nothing else to deliver, 400s rather than seeding an empty turn', async () => {
    const { controller, store, secrets, seedCalls } = makeController();
    await expect(
      controller.postMessage(owner, {} as never, 'job-1', {
        messages: [{ type: 'secret_provided', requestId: 's-eph', value: '123456' }],
      }),
    ).rejects.toBeInstanceOf(BadRequestException);
    // Never written, never seeded.
    expect(store.markSecretProvidedPerCard).not.toHaveBeenCalled();
    expect(secrets.write).not.toHaveBeenCalled();
    expect(seedCalls).toHaveLength(0);
  });

  it('rejects a batch with too many items before any write', async () => {
    const { controller, store, secrets } = makeController();
    await expect(
      controller.postMessage(owner, {} as never, 'job-1', {
        messages: Array.from({ length: 51 }, () => ({
          type: 'answer_question' as const,
          questionId: 'q-1',
          answer: 'Postgres',
        })),
      }),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(store.markQuestionAnswered).not.toHaveBeenCalled();
    expect(secrets.write).not.toHaveBeenCalled();
  });

  it('rejects a batch whose total inline content exceeds MAX_BATCH_BYTES with 400', async () => {
    const { controller, secrets } = makeController();
    const tooBig = 'a'.repeat(4 * 1024 * 1024 + 1);
    await expect(
      controller.postMessage(owner, {} as never, 'job-1', {
        messages: [
          {
            type: 'file_answered',
            requestId: 'f-1',
            filename: 'big',
            content: tooBig,
          },
        ],
      }),
    ).rejects.toBeInstanceOf(BadRequestException);
    // Rejected before any write.
    expect(secrets.write).not.toHaveBeenCalled();
  });
});

describe('WebSurfaceController — /message (mixed: answered cards + an operator message)', () => {
  it('composes ONE pre-framed seed turn (answer notices + the operator message, user-last) and delivers it via StimulusIntake', async () => {
    const { controller, store, secrets, seedCalls, intake, composedCalls } = makeController();
    const user = { id: 'u-1', displayName: 'Dennis', name: 'Dennis' };
    const res = await controller.postMessage(owner, user as never, 'job-1', {
      messages: [
        {
          type: 'answer_question',
          questionId: 'q-1',
          answer: 'Postgres',
        },
        {
          type: 'file_answered',
          requestId: 'f-1',
          filename: 'keys.env',
          content: 'A=1',
        },
        { type: 'secret_provided', requestId: 's-1', value: 'sk-live-123' },
        { type: 'user', text: 'thanks!' },
      ],
    });

    expect(res.ok).toBe(true);
    expect(res.results).toEqual([
      { id: 'q-1', status: 'applied' },
      { id: 'f-1', status: 'applied' },
      { id: 's-1', status: 'applied' },
    ]);
    expect(store.markQuestionAnswered).toHaveBeenCalledOnce();
    expect(secrets.write).toHaveBeenCalledTimes(2);

    // The mixed case bypasses `surface.seedSystemNotification` entirely (no double-wrap) — it goes
    // through the `StimulusIntake` composed-seed seam instead.
    expect(seedCalls).toHaveLength(0);
    expect(intake.intakeComposedSeed).toHaveBeenCalledOnce();

    const { input, transport } = composedCalls[0];
    expect(input).toMatchObject({
      operatorBubbleText: 'thanks!',
      deliveredQuestionIds: ['q-1'],
      deliveredFileIds: ['f-1'],
      deliveredSecretIds: ['s-1'],
    });
    const body = (input as { body: string }).body;
    // Answer notices frame as `<system_notice>` chunks; the operator message is the trailing `<user>`
    // chunk (renderTurn's canonical ordering — user always last).
    expect(body).toContain('Postgres');
    expect(body).toContain('.env.keys');
    expect(body).toContain('API_KEY');
    expect(body.indexOf('thanks!')).toBeGreaterThan(body.indexOf('API_KEY'));
    expect(body).toMatch(/<user[^>]*>[\s\S]*thanks!/);

    expect(transport).toMatchObject({
      bubbleAuthor: { id: 'u-1', displayName: 'Dennis' },
      replyRoute: { surfaceId: 'web', jobRef: 'job-1' },
    });
  });
});
