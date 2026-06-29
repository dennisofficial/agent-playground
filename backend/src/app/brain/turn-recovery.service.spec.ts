import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Repository } from 'typeorm';
import type { MessageEntity, ThreadSandboxEntity } from '../persistence/entities';
import type { SandboxProvider } from '../sandbox/sandbox-provider.port';
import { TurnRecoveryService } from './turn-recovery.service';

const line = (o: Record<string, unknown>): string => JSON.stringify(o);

/** A completed turn: operator prompt → thinking → text → tool_use → tool_result → end_turn text. */
const TRANSCRIPT = [
  line({ type: 'user', uuid: 'u-prompt', sessionId: 's1', timestamp: '2026-06-29T15:11:00.000Z', message: { role: 'user', content: 'Do a deep dive review.' } }),
  line({ type: 'assistant', uuid: 'a-think', sessionId: 's1', timestamp: '2026-06-29T15:11:01.000Z', message: { id: 'm1', stop_reason: 'tool_use', content: [{ type: 'thinking', thinking: 'Looking.' }] } }),
  line({ type: 'assistant', uuid: 'a-text', sessionId: 's1', timestamp: '2026-06-29T15:11:02.000Z', message: { id: 'm1', stop_reason: 'tool_use', content: [{ type: 'text', text: 'Reading the repo.' }] } }),
  line({ type: 'assistant', uuid: 'a-tool', sessionId: 's1', timestamp: '2026-06-29T15:11:03.000Z', message: { id: 'm1', stop_reason: 'tool_use', content: [{ type: 'tool_use', id: 'toolu_1', name: 'Read', input: { file_path: 'README.md' } }] } }),
  line({ type: 'user', uuid: 'u-res', sessionId: 's1', timestamp: '2026-06-29T15:11:04.000Z', toolUseResult: { ok: true }, message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_1', content: '# README', is_error: false }] } }),
  line({ type: 'assistant', uuid: 'a-final', sessionId: 's1', timestamp: '2026-06-29T15:11:05.000Z', message: { id: 'm2', stop_reason: 'end_turn', content: [{ type: 'text', text: 'Here is the deep dive of the whole system.' }] } }),
].join('\n');

const THREAD_ID = 'thread-xyz';
const FINAL_REPLY = 'Here is the deep dive of the whole system.';
const PROVISIONING_NOTICE = 'Setting up an isolated workspace for this thread — one moment…';

function seedTranscript(content = TRANSCRIPT): string {
  const root = mkdtempSync(join(tmpdir(), 'turn-recovery-'));
  const slugDir = join(root, 'brain_x', 'claude', 'projects', '-workspace');
  mkdirSync(slugDir, { recursive: true });
  writeFileSync(join(slugDir, 's1.jsonl'), content);
  return join(root, 'brain_x', 'claude', 'projects');
}

type Row = Partial<MessageEntity>;

/** A stateful messages-repo mock: `save` accumulates rows; `getCount` answers the final-reply-present
 *  query (does any Atlas message contain the needle?); `getRawMany` answers persistedSdkUuids. */
function makeMessages(seed: Row[]) {
  const saved: Row[] = [...seed];
  const repo = {
    create: (row: Row) => row,
    save: vi.fn(async (row: Row) => {
      saved.push(row);
      return row;
    }),
    createQueryBuilder: () => {
      const params: Record<string, unknown> = {};
      const qb: Record<string, unknown> = {};
      for (const m of ['select', 'where', 'andWhere']) {
        qb[m] = (_cond: unknown, p?: Record<string, unknown>) => {
          if (p) Object.assign(params, p);
          return qb;
        };
      }
      qb.getCount = async () => {
        const needle = String(params.needle ?? '');
        return saved.filter((r) => r.author_id === 'atlas' && typeof r.text === 'string' && needle && r.text.includes(needle)).length;
      };
      qb.getRawMany = async () =>
        saved.filter((r) => (r.meta as { sdkUuid?: string })?.sdkUuid).map((r) => ({ u: (r.meta as { sdkUuid: string }).sdkUuid }));
      return qb;
    },
  } as unknown as Repository<MessageEntity>;
  return { repo, saved };
}

/** sandboxRows mock: candidateThreadIds returns the given thread ids. */
function makeSandboxRows(threadIds: string[]) {
  return {
    createQueryBuilder: () => {
      const qb: Record<string, unknown> = {};
      for (const m of ['select', 'where']) qb[m] = () => qb;
      qb.getRawMany = async () => threadIds.map((threadId) => ({ threadId }));
      return qb;
    },
  } as unknown as Repository<ThreadSandboxEntity>;
}

function makeProvider(projectsDir: string | null): SandboxProvider {
  return { brainTranscriptProjectsDir: () => projectsDir } as unknown as SandboxProvider;
}

/** Messages a FIRST/cold interrupted turn leaves behind: the operator prompt + the provisioning notice
 *  (Atlas-authored, persisted AFTER the prompt) — and crucially NO transcript reply. */
const INTERRUPTED_FIRST_TURN: Row[] = [
  { author_id: 'U-OP', text: 'Do a deep dive review.', kind: 'chat' },
  { author_id: 'atlas', text: PROVISIONING_NOTICE, kind: 'chat' },
];

afterEach(() => vi.restoreAllMocks());

describe('TurnRecoveryService', () => {
  it('REGRESSION: recovers when the last durable row is the provisioning notice (not the operator prompt)', async () => {
    const projects = seedTranscript();
    const { repo, saved } = makeMessages(INTERRUPTED_FIRST_TURN);
    const svc = new TurnRecoveryService(repo, makeSandboxRows([THREAD_ID]), makeProvider(projects));

    const recovered = await svc.recoverInterruptedTurns();

    expect(recovered).toBe(1);
    const inserted = saved.slice(INTERRUPTED_FIRST_TURN.length);
    expect(inserted.map((r) => r.kind)).toEqual(['thinking', 'chat', 'tool', 'chat']);
    expect(inserted.map((r) => (r.meta as { sdkUuid: string }).sdkUuid)).toEqual(['a-think', 'a-text', 'a-tool', 'a-final']);
    expect(inserted.every((r) => r.author_id === 'atlas')).toBe(true);
    const times = inserted.map((r) => (r.created_at as Date).getTime());
    expect(times.every((t, i) => i === 0 || t > times[i - 1])).toBe(true);
  });

  it('is idempotent — a second run sees the final reply persisted and inserts nothing', async () => {
    const projects = seedTranscript();
    const { repo, saved } = makeMessages(INTERRUPTED_FIRST_TURN);
    const svc = new TurnRecoveryService(repo, makeSandboxRows([THREAD_ID]), makeProvider(projects));

    await svc.recoverInterruptedTurns();
    const afterFirst = saved.length;
    const recovered2 = await svc.recoverInterruptedTurns();

    expect(recovered2).toBe(0);
    expect(saved.length).toBe(afterFirst);
  });

  it('skips a thread whose turn was already persisted normally (final reply present)', async () => {
    const projects = seedTranscript();
    const { repo, saved } = makeMessages([
      { author_id: 'U-OP', text: 'Do a deep dive review.', kind: 'chat' },
      { author_id: 'atlas', text: `${FINAL_REPLY} (already here)`, kind: 'chat' },
    ]);
    const svc = new TurnRecoveryService(repo, makeSandboxRows([THREAD_ID]), makeProvider(projects));

    expect(await svc.recoverInterruptedTurns()).toBe(0);
    expect(saved.length).toBe(2);
  });

  it('does not recover an in-flight turn that never reached end_turn', async () => {
    const cutOff = TRANSCRIPT.split('\n').slice(0, 4).join('\n');
    const projects = seedTranscript(cutOff);
    const { repo, saved } = makeMessages(INTERRUPTED_FIRST_TURN);
    const svc = new TurnRecoveryService(repo, makeSandboxRows([THREAD_ID]), makeProvider(projects));

    expect(await svc.recoverInterruptedTurns()).toBe(0);
    expect(saved.length).toBe(INTERRUPTED_FIRST_TURN.length);
  });

  it('no-ops when no transcript dir exists for the thread', async () => {
    const { repo, saved } = makeMessages(INTERRUPTED_FIRST_TURN);
    const svc = new TurnRecoveryService(repo, makeSandboxRows([THREAD_ID]), makeProvider(null));

    expect(await svc.recoverInterruptedTurns()).toBe(0);
    expect(saved.length).toBe(INTERRUPTED_FIRST_TURN.length);
  });

  it('no-ops when there are no non-closed sandbox threads', async () => {
    const projects = seedTranscript();
    const { repo, saved } = makeMessages(INTERRUPTED_FIRST_TURN);
    const svc = new TurnRecoveryService(repo, makeSandboxRows([]), makeProvider(projects));

    expect(await svc.recoverInterruptedTurns()).toBe(0);
    expect(saved.length).toBe(INTERRUPTED_FIRST_TURN.length);
  });

  it('finishAndRecover WATCHES an in-flight (orphaned) turn and recovers it once it reaches end_turn', async () => {
    // Start with a transcript that is still generating (no end_turn) — the immediate pass would skip it.
    const root = mkdtempSync(join(tmpdir(), 'turn-recovery-'));
    const slugDir = join(root, 'brain_x', 'claude', 'projects', '-workspace');
    mkdirSync(slugDir, { recursive: true });
    const file = join(slugDir, 's1.jsonl');
    writeFileSync(file, TRANSCRIPT.split('\n').slice(0, 4).join('\n')); // no end_turn yet
    const projects = join(root, 'brain_x', 'claude', 'projects');

    const { repo, saved } = makeMessages(INTERRUPTED_FIRST_TURN);
    const svc = new TurnRecoveryService(repo, makeSandboxRows([THREAD_ID]), makeProvider(projects));

    // The orphaned engine "finishes" shortly after the watch starts.
    setTimeout(() => writeFileSync(file, TRANSCRIPT), 15);
    await svc.finishAndRecover([THREAD_ID], { intervalMs: 10, timeoutMs: 2000 });

    const inserted = saved.slice(INTERRUPTED_FIRST_TURN.length);
    expect(inserted.map((r) => r.kind)).toEqual(['thinking', 'chat', 'tool', 'chat']);
  });

  it('finishAndRecover stops watching after the timeout if the turn never completes', async () => {
    const root = mkdtempSync(join(tmpdir(), 'turn-recovery-'));
    const slugDir = join(root, 'brain_x', 'claude', 'projects', '-workspace');
    mkdirSync(slugDir, { recursive: true });
    writeFileSync(join(slugDir, 's1.jsonl'), TRANSCRIPT.split('\n').slice(0, 4).join('\n')); // never completes
    const projects = join(root, 'brain_x', 'claude', 'projects');

    const { repo, saved } = makeMessages(INTERRUPTED_FIRST_TURN);
    const svc = new TurnRecoveryService(repo, makeSandboxRows([THREAD_ID]), makeProvider(projects));

    await svc.finishAndRecover([THREAD_ID], { intervalMs: 10, timeoutMs: 30 });

    expect(saved.length).toBe(INTERRUPTED_FIRST_TURN.length); // nothing back-filled
  });
});
