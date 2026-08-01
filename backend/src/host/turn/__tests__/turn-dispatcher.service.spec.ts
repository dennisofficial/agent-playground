import type { PrismaService } from '@lib/prisma/prisma.service';
import { describe, expect, it, vi } from 'vitest';
import type { SteeringFrame } from '../../../_shared/engine/turn-spec';
import type { InboundMessageModel as InboundMessage } from '../../../generated/prisma/models';
import type { HostTransportService } from '../../host-transport/host-transport.service';
import type { InboundMessageService } from '../../inbound-message/inbound-message.service';
import type { SandboxService } from '../../sandbox/sandbox.service';
import { TurnDispatcherService } from '../turn-dispatcher.service';
import type { TurnSpecBuilderService } from '../turn-spec-builder.service';
import type { TurnTranscriptService } from '../turn-transcript.service';

const row = (id: string, text: string): InboundMessage =>
  ({ id, text, jobId: 'job-1', threadId: 'thread-1', orgId: 'org-1' }) as InboundMessage;

const messageStart = { type: 'stream_event', event: { type: 'message_start' } };

const BOUNDARY_MS = 1_700_000_000_000;

function harness(opts: {
  steer?: InboundMessage;
  script: (ctl: { release: () => void; steerSent: Promise<void> }) => Array<() => Promise<unknown>>;
}) {
  const forwarded: SteeringFrame[] = [];
  let onForward: () => void;
  const steerSent = new Promise<void>((resolve) => {
    onForward = resolve;
  });
  let steerAvailable = false;
  const release = () => {
    steerAvailable = true;
  };

  const transport = {
    writeSpec: vi.fn(async () => {}),
    markTurnLive: vi.fn(async () => {}),
    clearTurnLive: vi.fn(async () => {}),
    disposeTurn: vi.fn(async () => {}),
    writeInput: vi.fn(async (_turnId: string, frame: SteeringFrame) => {
      forwarded.push(frame);
      onForward();
    }),
    async *readEvents() {
      // Mirrors the real generator: each event carries the Redis entry id it was appended at.
      for (const step of opts.script({ release, steerSent }))
        yield { event: await step(), emittedAt: BOUNDARY_MS };
    },
  } as unknown as HostTransportService;

  const consumed: Array<{ id: string; orderAt: Date | null }> = [];
  let swept = false;
  const inbound = {
    // The steer only appears once the script releases it; one sweep hands it over, later sweeps find nothing.
    pendingNowExcluding: vi.fn(async () => {
      if (swept || !steerAvailable || !opts.steer) return [];
      swept = true;
      return [opts.steer];
    }),
    consume: vi.fn(async (r: InboundMessage, orderAt: Date | null) => {
      consumed.push({ id: r.id, orderAt });
    }),
  } as unknown as InboundMessageService;

  const dispatcher = new TurnDispatcherService(
    { build: vi.fn(async () => ({ prompt: 'go' })) } as unknown as TurnSpecBuilderService,
    transport,
    {
      launchEngineTurn: vi.fn(async () => {}),
      touch: vi.fn(async () => {}),
    } as unknown as SandboxService,
    inbound,
    { record: vi.fn(async () => {}) } as unknown as TurnTranscriptService,
    {} as unknown as PrismaService,
  );

  return { dispatcher, forwarded, consumed };
}

describe('TurnDispatcherService.run', () => {
  it('queues a mid-turn steer for the next boundary instead of interrupting the response', async () => {
    const { dispatcher, forwarded } = harness({
      steer: row('steer-1', 'say hello'),
      script: ({ release, steerSent }) => [
        async () => messageStart,
        async () => {
          release();
          await steerSent;
          return { type: 'assistant' };
        },
        async () => ({ type: 'result' }),
      ],
    });

    await dispatcher.run('job-1', [row('trigger-1', 'go')]);

    // `now` cuts the in-flight response off mid-sentence; `next` lets it finish and lands at a tool boundary.
    expect(forwarded).toEqual([{ text: 'say hello', priority: 'next' }]);
  });

  it('leaves a steer PENDING when the turn ends without ever reaching a boundary', async () => {
    const { dispatcher, consumed } = harness({
      steer: row('steer-1', 'say hello'),
      script: ({ release, steerSent }) => [
        // One long stretch of prose: the message opens, the steer arrives mid-generation, the message ends.
        async () => messageStart,
        async () => {
          release();
          await steerSent;
          return { type: 'assistant' };
        },
        async () => ({ type: 'result' }),
      ],
    });

    await dispatcher.run('job-1', [row('trigger-1', 'go')]);

    expect(consumed.map((c) => c.id)).toEqual(['trigger-1']);
  });

  it('consumes a steer at the boundary the model opened, keyed to the engine clock', async () => {
    const { dispatcher, consumed } = harness({
      steer: row('steer-1', 'say hello'),
      script: ({ release, steerSent }) => [
        async () => messageStart,
        async () => {
          release(); // steer arrives while the first message is still being generated
          return { type: 'assistant' }; // …which then completes: a tool boundary
        },
        async () => {
          await steerSent;
          return messageStart; // the steer is injected there, and a fresh message opens
        },
        async () => ({ type: 'assistant' }),
        async () => ({ type: 'result' }),
      ],
    });

    await dispatcher.run('job-1', [row('trigger-1', 'go')]);

    expect(consumed.map((c) => c.id)).toEqual(['trigger-1', 'steer-1']);
    expect(consumed[0].orderAt?.getTime()).not.toBe(BOUNDARY_MS);
    expect(consumed[1].orderAt?.getTime()).toBe(BOUNDARY_MS);
  });

  it('writes the bubble when the message OPENS, not when it completes', async () => {
    const seenAtOpen: string[][] = [];
    const { dispatcher, consumed } = harness({
      script: () => [
        async () => messageStart,
        async () => {
          seenAtOpen.push(consumed.map((c) => c.id));
          return { type: 'assistant' };
        },
        async () => ({ type: 'result' }),
      ],
    });

    await dispatcher.run('job-1', [row('trigger-1', 'go')]);

    expect(seenAtOpen[0]).toEqual(['trigger-1']);
  });

  it('still consumes an unseen TRIGGER batch at turn end, so a failing turn cannot retry-loop', async () => {
    const { dispatcher, consumed } = harness({
      script: () => [async () => ({ type: 'result' })], // engine died before emitting anything
    });

    await dispatcher.run('job-1', [row('trigger-1', 'go')]);

    expect(consumed.map((c) => c.id)).toEqual(['trigger-1']);
  });
});
