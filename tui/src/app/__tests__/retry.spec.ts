import { describe, expect, it } from 'bun:test';
import { EHarnessVariant, type Message } from '../../domain/message.js';
import type { PhaseBrief } from '../../domain/phase-brief.js';
import { EMessageType, EThreadStatus } from '../../generated/prisma/enums.js';
import type { EngineSession, Job, Thread } from '../../generated/prisma/client.js';
import type { JobRepository } from '../../store/job.repository.js';
import type { MessageRepository } from '../../store/message.repository.js';
import type { SessionRepository } from '../../store/session.repository.js';
import type { ThreadRepository } from '../../store/thread.repository.js';
import type { TurnRepository } from '../../store/turn.repository.js';
import type { AccountUsageService } from '../account-usage.service.js';
import type { ContextFolderService } from '../context-folder.service.js';
import { ConversationStoreRegistry } from '../conversation-store.registry.js';
import { ConversationService } from '../conversation.service.js';
import type { PhaseBriefService } from '../phase-brief.service.js';
import type { SessionManagerService } from '../session-manager.service.js';
import type { ThreadSeamService } from '../thread-seam.service.js';
import type { RunTurnArgs, TurnRunnerService } from '../turn-runner.service.js';

/**
 * Clicking `↻ retry` sends the failed turn's prompt again — and sends it as whoever sent it, which
 * is the half a re-typed message could not reproduce.
 */

const JOB = { id: 'job-1', title: 'fix steering', activeThreadId: 'thread-a' } as unknown as Job;
const THREAD = {
  id: 'thread-a',
  role: 'builder',
  status: EThreadStatus.active,
  activeSessionId: 'session-1',
  phaseId: 'phase-1',
} as unknown as Thread;

function message(id: string, payload: Message['payload']): Message {
  return { id, payload } as unknown as Message;
}

const FAILED = message('m-2', {
  type: EMessageType.error,
  title: 'Turn ended: error_during_execution',
  retryable: true,
});

function build(args: { persisted: Message[]; busy?: boolean }): {
  conversationService: ConversationService;
  fired: RunTurnArgs[];
} {
  const fired: RunTurnArgs[] = [];
  const session = {
    id: 'session-1',
    accountId: 'account-1',
    engine: 'claude',
    model: 'claude-opus-5',
    ordinal: 1,
  } as unknown as EngineSession;

  const conversationService = new ConversationService(
    {} as unknown as JobRepository,
    { async findById(): Promise<Thread> { return THREAD; } } as unknown as ThreadRepository,
    {
      async findById(): Promise<EngineSession> { return session; },
      async claim(): Promise<boolean> { return true; },
      async refsForThread(): Promise<[]> { return []; },
    } as unknown as SessionRepository,
    {
      async listForThread(): Promise<Message[]> { return args.persisted; },
    } as unknown as MessageRepository,
    { async lastForThread(): Promise<null> { return null; } } as unknown as TurnRepository,
    {
      async currentSession(): Promise<EngineSession> { return session; },
    } as unknown as SessionManagerService,
    {
      busy: (): boolean => args.busy ?? false,
      async run(turn: RunTurnArgs): Promise<void> {
        fired.push(turn);
      },
    } as unknown as TurnRunnerService,
    { ensure: (): string => '/tmp/context' } as unknown as ContextFolderService,
    { kick: (): void => undefined } as unknown as AccountUsageService,
    {
      async forPhase(): Promise<PhaseBrief> {
        return { instructions: 'phase instructions', opening: 'phase opening' };
      },
    } as unknown as PhaseBriefService,
    { async toolsFor(): Promise<[]> { return []; } } as unknown as ThreadSeamService,
    new ConversationStoreRegistry(),
  );

  return { conversationService, fired };
}

describe('retrying a failed turn', () => {
  it('sends the human’s words again, bare', async () => {
    const { conversationService, fired } = build({
      persisted: [message('m-1', { type: EMessageType.user, text: 'run the tests' }), FAILED],
    });
    await conversationService.openThread(JOB, THREAD, '/repo');

    await conversationService.retry();

    expect(fired).toHaveLength(1);
    expect(fired[0]?.prompt).toBe('run the tests');
    // No variant: the absence of one IS the human, so a retry that passed one would have Atlas
    // impersonating Dennis on the way back in. See `promptPayload`.
    expect(fired[0]?.harnessVariant).toBeUndefined();
  });

  it('sends Atlas’s hand-off again as a hand-off, attachments intact', async () => {
    const attachments = [
      { label: 'context/notes.md', lines: 1, bytes: 6, body: 'a note' },
    ] as const;
    const { conversationService, fired } = build({
      persisted: [
        message('m-1', {
          type: EMessageType.harness,
          variant: EHarnessVariant.handoff,
          text: 'here is where the last leg got to',
          attachments,
        }),
        FAILED,
      ],
    });
    await conversationService.openThread(JOB, THREAD, '/repo');

    await conversationService.retry();

    expect(fired[0]?.harnessVariant).toBe(EHarnessVariant.handoff);
    expect(fired[0]?.attachments).toEqual(attachments);
  });

  it('declines while a turn is already running — a click can race the store it was drawn from', async () => {
    const { conversationService, fired } = build({
      persisted: [message('m-1', { type: EMessageType.user, text: 'run the tests' }), FAILED],
      busy: true,
    });
    await conversationService.openThread(JOB, THREAD, '/repo');

    await conversationService.retry();

    expect(fired).toHaveLength(0);
  });

  it('declines when the last turn did not fail', async () => {
    const { conversationService, fired } = build({
      persisted: [
        message('m-1', { type: EMessageType.user, text: 'run the tests' }),
        message('m-2', { type: EMessageType.assistant, text: 'all green' }),
      ],
    });
    await conversationService.openThread(JOB, THREAD, '/repo');

    await conversationService.retry();

    expect(fired).toHaveLength(0);
  });
});
