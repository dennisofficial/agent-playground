import { describe, expect, it, vi } from 'vitest';
import type { ChatStimulus } from '../domain';
import type { EngineEvent } from '../engine/engine.types';
import { AgentSessionManager } from './agent-session-manager.service';

const JOB_ID = 'th-ack-001';

/** Minimal `findChatStimulusById` resolution — only the fields `markCardDeliveredForStimulus` reads. */
function stimulusStub(fields: Partial<ChatStimulus>): ChatStimulus {
  return {
    id: 'st1',
    orgId: 'T-ACK',
    repoId: 'repo-ack',
    kind: 'chat',
    trust: 'trusted',
    jobId: JOB_ID,
    body: 'body',
    author: { id: 'U1', displayName: 'Dennis' },
    replyRoute: { surfaceId: 'web', jobRef: JOB_ID },
    receivedAt: new Date('2026-07-02T12:00:00Z'),
    ...fields,
  };
}

/** A manager wired with only the deps `stampInputAck`/`markCardDeliveredForStimulus` touch; everything else inert. */
function makeManager(opts: {
  findChatStimulusById: ReturnType<typeof vi.fn>;
  getQuestionCard?: ReturnType<typeof vi.fn>;
  markQuestionDelivered?: ReturnType<typeof vi.fn>;
  getSecretCard?: ReturnType<typeof vi.fn>;
  markSecretDelivered?: ReturnType<typeof vi.fn>;
  clearAwaitingSecret?: ReturnType<typeof vi.fn>;
  getFileCard?: ReturnType<typeof vi.fn>;
  markFileDelivered?: ReturnType<typeof vi.fn>;
  markChatDelivered?: ReturnType<typeof vi.fn>;
}) {
  const store = {
    getQuestionCard: opts.getQuestionCard ?? vi.fn().mockResolvedValue(null),
    markQuestionDelivered: opts.markQuestionDelivered ?? vi.fn().mockResolvedValue(undefined),
    getSecretCard: opts.getSecretCard ?? vi.fn().mockResolvedValue(null),
    markSecretDelivered: opts.markSecretDelivered ?? vi.fn().mockResolvedValue(undefined),
    clearAwaitingSecret: opts.clearAwaitingSecret ?? vi.fn().mockResolvedValue(undefined),
    getFileCard: opts.getFileCard ?? vi.fn().mockResolvedValue(null),
    markFileDelivered: opts.markFileDelivered ?? vi.fn().mockResolvedValue(undefined),
  };
  const stimulusStore = {
    findChatStimulusById: opts.findChatStimulusById,
    markChatDelivered: opts.markChatDelivered ?? vi.fn().mockResolvedValue(undefined),
  };
  const inert = {} as never;
  const manager = new AgentSessionManager(
    store as never, // store (1)
    inert, inert, inert, inert, inert, // driverStore, autoMerge, memory, approvals, lifecycle (6)
    inert, // engineRunner (7)
    inert, // turnRegistry (8)
    inert, inert, inert, // planReview, dispatcher, surface (11)
    inert, // sandboxRows (12)
    inert, // stimulusRows (13)
    stimulusStore as never, // stimulusStore (14)
    inert, inert, inert, inert, inert, inert, inert, // turnHarness…creds (21)
    inert, // mcp (22)
    inert, // election (23)
    inert, inert, inert, inert, // turnRecovery…git (27)
    inert, // prompts (PromptService)
    inert, // threadInput (ThreadInputService)
    inert, // liveVerificationJudge (LIVE_VERIFICATION_JUDGE)
    inert, // usage (OauthUsageService)
  );
  return { manager, store, stimulusStore };
}

/** Flush the floating async IIFE `stampInputAck` fires. */
async function flush() {
  await new Promise((r) => setImmediate(r));
  await new Promise((r) => setImmediate(r));
}

function callStampInputAck(manager: AgentSessionManager, e: EngineEvent) {
  (manager as unknown as { stampInputAck: (e: EngineEvent) => void }).stampInputAck(e);
}

describe('AgentSessionManager.stampInputAck / markCardDeliveredForStimulus', () => {
  it('stamps a delivered QUESTION card + the stimulus row', async () => {
    const findChatStimulusById = vi
      .fn()
      .mockResolvedValue(stimulusStub({ seedQuestionId: 'q1' }));
    const getQuestionCard = vi
      .fn()
      .mockResolvedValue({ answer: 'yes', deliveredAt: null });
    const { manager, store, stimulusStore } = makeManager({
      findChatStimulusById,
      getQuestionCard,
    });

    callStampInputAck(manager, { kind: 'input_ack', id: 'st1' });
    await flush();

    expect(store.markQuestionDelivered).toHaveBeenCalledTimes(1);
    expect(store.markQuestionDelivered).toHaveBeenCalledWith(JOB_ID, 'q1');
    expect(stimulusStore.markChatDelivered).toHaveBeenCalledTimes(1);
    expect(stimulusStore.markChatDelivered).toHaveBeenCalledWith('st1');
  });

  it('stamps a delivered SECRET card AND clears the secret gate', async () => {
    const findChatStimulusById = vi
      .fn()
      .mockResolvedValue(stimulusStub({ seedSecretId: 's1' }));
    const getSecretCard = vi
      .fn()
      .mockResolvedValue({
        provided_at: new Date('2026-07-02T12:00:00Z'),
        delivered_at: null,
        ephemeral: true,
      });
    const { manager, store, stimulusStore } = makeManager({
      findChatStimulusById,
      getSecretCard,
    });

    callStampInputAck(manager, { kind: 'input_ack', id: 'st1' });
    await flush();

    expect(store.markSecretDelivered).toHaveBeenCalledTimes(1);
    expect(store.markSecretDelivered).toHaveBeenCalledWith(JOB_ID, 's1');
    expect(store.clearAwaitingSecret).toHaveBeenCalledTimes(1);
    expect(store.clearAwaitingSecret).toHaveBeenCalledWith(JOB_ID, 's1');
    expect(stimulusStore.markChatDelivered).toHaveBeenCalledWith('st1');
  });

  it('stamps a delivered FILE card', async () => {
    const findChatStimulusById = vi
      .fn()
      .mockResolvedValue(stimulusStub({ seedFileId: 'f1' }));
    const getFileCard = vi
      .fn()
      .mockResolvedValue({ provided_at: new Date('2026-07-02T12:00:00Z'), delivered_at: null });
    const { manager, store, stimulusStore } = makeManager({
      findChatStimulusById,
      getFileCard,
    });

    callStampInputAck(manager, { kind: 'input_ack', id: 'st1' });
    await flush();

    expect(store.markFileDelivered).toHaveBeenCalledTimes(1);
    expect(store.markFileDelivered).toHaveBeenCalledWith(JOB_ID, 'f1');
    expect(stimulusStore.markChatDelivered).toHaveBeenCalledWith('st1');
  });

  it('a plain (non-ack / id-less) event is a no-op — never touches the stores', async () => {
    const findChatStimulusById = vi.fn();
    const { manager, stimulusStore } = makeManager({ findChatStimulusById });

    callStampInputAck(manager, { kind: 'chunk' } as unknown as EngineEvent);
    callStampInputAck(manager, { kind: 'input_ack', id: '' });
    await flush();

    expect(findChatStimulusById).not.toHaveBeenCalled();
    expect(stimulusStore.markChatDelivered).not.toHaveBeenCalled();
  });

  it('an UNANSWERED question card is not stamped, but the stimulus row is still marked delivered', async () => {
    const findChatStimulusById = vi
      .fn()
      .mockResolvedValue(stimulusStub({ seedQuestionId: 'q1' }));
    const getQuestionCard = vi.fn().mockResolvedValue({ answer: null, deliveredAt: null });
    const { manager, store, stimulusStore } = makeManager({
      findChatStimulusById,
      getQuestionCard,
    });

    callStampInputAck(manager, { kind: 'input_ack', id: 'st1' });
    await flush();

    expect(store.markQuestionDelivered).not.toHaveBeenCalled();
    expect(stimulusStore.markChatDelivered).toHaveBeenCalledWith('st1');
  });

  it('does NOT mark the stimulus row delivered when the question card stamp fails', async () => {
    const findChatStimulusById = vi
      .fn()
      .mockResolvedValue(stimulusStub({ seedQuestionId: 'q1' }));
    const getQuestionCard = vi
      .fn()
      .mockResolvedValue({ answer: 'yes', deliveredAt: null });
    const markQuestionDelivered = vi.fn().mockRejectedValue(new Error('db write failed'));
    const { manager, stimulusStore } = makeManager({
      findChatStimulusById,
      getQuestionCard,
      markQuestionDelivered,
    });

    callStampInputAck(manager, { kind: 'input_ack', id: 'st1' });
    await flush();

    expect(markQuestionDelivered).toHaveBeenCalledWith(JOB_ID, 'q1');
    expect(stimulusStore.markChatDelivered).not.toHaveBeenCalled();
  });

  it('clears the secret gate even when the secret card was already marked delivered', async () => {
    const findChatStimulusById = vi
      .fn()
      .mockResolvedValue(stimulusStub({ seedSecretId: 's1' }));
    const getSecretCard = vi.fn().mockResolvedValue({
      provided_at: new Date('2026-07-02T12:00:00Z'),
      delivered_at: new Date('2026-07-02T12:00:01Z'),
      ephemeral: true,
    });
    const { manager, store, stimulusStore } = makeManager({
      findChatStimulusById,
      getSecretCard,
    });

    callStampInputAck(manager, { kind: 'input_ack', id: 'st1' });
    await flush();

    expect(store.markSecretDelivered).not.toHaveBeenCalled();
    expect(store.clearAwaitingSecret).toHaveBeenCalledWith(JOB_ID, 's1');
    expect(stimulusStore.markChatDelivered).toHaveBeenCalledWith('st1');
  });

  it('does NOT mark the stimulus row delivered when clearing the secret gate fails', async () => {
    const findChatStimulusById = vi
      .fn()
      .mockResolvedValue(stimulusStub({ seedSecretId: 's1' }));
    const getSecretCard = vi
      .fn()
      .mockResolvedValue({
        provided_at: new Date('2026-07-02T12:00:00Z'),
        delivered_at: null,
        ephemeral: true,
      });
    const clearAwaitingSecret = vi.fn().mockRejectedValue(new Error('gate clear failed'));
    const { manager, store, stimulusStore } = makeManager({
      findChatStimulusById,
      getSecretCard,
      clearAwaitingSecret,
    });

    callStampInputAck(manager, { kind: 'input_ack', id: 'st1' });
    await flush();

    expect(store.markSecretDelivered).toHaveBeenCalledWith(JOB_ID, 's1');
    expect(clearAwaitingSecret).toHaveBeenCalledWith(JOB_ID, 's1');
    expect(stimulusStore.markChatDelivered).not.toHaveBeenCalled();
  });
});
