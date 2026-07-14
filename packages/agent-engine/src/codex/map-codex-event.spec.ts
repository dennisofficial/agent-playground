import { describe, expect, it, vi } from 'vitest';
import type { CodexEvent, CodexItem } from '@workspace/codex-sdk';
import { CodexAppServerAdapter, type CodexHomeProvisioner } from './codex-app-server-adapter.js';
import { mapCodexEvent, type MapCodexEventCtx } from './map-codex-event.js';

function ctx(over: Partial<MapCodexEventCtx> = {}): MapCodexEventCtx {
  return { cwd: '/tmp/nonexistent-worktree', richStream: false, ...over };
}

function itemCompleted(item: CodexItem): CodexEvent {
  return { type: 'itemCompleted', threadId: 't', turnId: 'u', item, raw: {} };
}

describe('mapCodexEvent', () => {
  it('maps an agent_message to a text event and surfaces the running result', () => {
    const onResult = vi.fn();
    const out = mapCodexEvent(
      itemCompleted({ id: 'a', type: 'agent_message', text: 'the answer' }),
      ctx({ onResult }),
    );
    expect(out).toEqual([{ kind: 'text', text: 'the answer' }]);
    expect(onResult).toHaveBeenCalledWith('the answer');
  });

  it('maps reasoning to thinking under richStream and to text otherwise', () => {
    const item: CodexItem = { id: 'r', type: 'reasoning', text: 'pondering' };
    expect(mapCodexEvent(itemCompleted(item), ctx({ richStream: true }))).toEqual([
      { kind: 'thinking', text: 'pondering' },
    ]);
    expect(mapCodexEvent(itemCompleted(item), ctx({ richStream: false }))).toEqual([
      { kind: 'text', text: 'pondering' },
    ]);
  });

  it('expands command_execution into a tool_use/tool_result pair under richStream', () => {
    const item: CodexItem = {
      id: 'c1',
      type: 'command_execution',
      command: 'ls -a',
      aggregated_output: 'file.txt',
      exit_code: 0,
      status: 'completed',
    };
    expect(mapCodexEvent(itemCompleted(item), ctx({ richStream: true }))).toEqual([
      { kind: 'tool_use', id: 'c1', name: 'bash', input: { command: 'ls -a' } },
      { kind: 'tool_result', id: 'c1', result: 'file.txt', isError: false },
    ]);
  });

  it('flags command_execution as error on a non-zero exit code', () => {
    const item: CodexItem = {
      id: 'c2',
      type: 'command_execution',
      command: 'false',
      aggregated_output: '',
      exit_code: 1,
      status: 'completed',
    };
    const [, result] = mapCodexEvent(itemCompleted(item), ctx({ richStream: true }));
    expect(result).toMatchObject({ kind: 'tool_result', isError: true });
  });

  it('emits a coarse tool event for command_execution without richStream', () => {
    const item: CodexItem = { id: 'c3', type: 'command_execution', command: 'pwd' };
    expect(mapCodexEvent(itemCompleted(item), ctx({ richStream: false }))).toEqual([
      { kind: 'tool', name: 'bash', detail: 'pwd' },
    ]);
  });

  it('keeps a single-file file_change on the item id under richStream', () => {
    const item: CodexItem = {
      id: 'fc1',
      type: 'file_change',
      status: 'completed',
      changes: [{ path: 'a.txt', kind: 'add' }],
    };
    const out = mapCodexEvent(itemCompleted(item), ctx({ richStream: true }));
    expect(out).toHaveLength(2);
    expect(out[0]).toMatchObject({ kind: 'tool_use', id: 'fc1', name: 'edit', input: { file_path: 'a.txt', kind: 'add' } });
    expect(out[1]).toMatchObject({ kind: 'tool_result', id: 'fc1', result: 'completed', isError: false });
  });

  it('splits a multi-file file_change into one indexed pair per file under richStream', () => {
    const item: CodexItem = {
      id: 'fc2',
      type: 'file_change',
      status: 'completed',
      changes: [
        { path: 'a.txt', kind: 'update' },
        { path: 'b.txt', kind: 'delete' },
      ],
    };
    const out = mapCodexEvent(itemCompleted(item), ctx({ richStream: true }));
    expect(out).toHaveLength(4);
    expect(out.filter((e) => e.kind === 'tool_use').map((e) => (e as { id: string }).id)).toEqual([
      'fc2:0',
      'fc2:1',
    ]);
  });

  it('emits one coarse edit event summarizing a file_change without richStream', () => {
    const item: CodexItem = {
      id: 'fc3',
      type: 'file_change',
      status: 'completed',
      changes: [
        { path: 'a.txt', kind: 'update' },
        { path: 'b.txt', kind: 'add' },
      ],
    };
    expect(mapCodexEvent(itemCompleted(item), ctx({ richStream: false }))).toEqual([
      { kind: 'tool', name: 'edit', detail: 'update a.txt, add b.txt' },
    ]);
  });

  it('maps an error item to a text event', () => {
    expect(mapCodexEvent(itemCompleted({ id: 'e', type: 'error', message: 'boom' }), ctx())).toEqual([
      { kind: 'text', text: 'error: boom' },
    ]);
  });

  it('gates agentMessageDelta and reasoning deltas on richStream', () => {
    const amDelta: CodexEvent = { type: 'agentMessageDelta', threadId: 't', turnId: 'u', itemId: 'i', delta: 'hi', raw: {} };
    expect(mapCodexEvent(amDelta, ctx({ richStream: true }))).toEqual([{ kind: 'text_delta', text: 'hi' }]);
    expect(mapCodexEvent(amDelta, ctx({ richStream: false }))).toEqual([]);

    const reasonDelta: CodexEvent = { type: 'reasoningTextDelta', threadId: 't', turnId: 'u', itemId: 'i', delta: 'mm', raw: {} };
    expect(mapCodexEvent(reasonDelta, ctx({ richStream: true }))).toEqual([{ kind: 'thinking_delta', text: 'mm' }]);
    expect(mapCodexEvent(reasonDelta, ctx({ richStream: false }))).toEqual([]);
  });

  it('produces no EngineEvent for lifecycle / unknown notifications', () => {
    const unknown: CodexEvent = { type: 'unknown', method: 'some/method', raw: {} };
    const turnStarted: CodexEvent = { type: 'turnStarted', threadId: 't', turnId: 'u', raw: {} };
    expect(mapCodexEvent(unknown, ctx({ richStream: true }))).toEqual([]);
    expect(mapCodexEvent(turnStarted, ctx({ richStream: true }))).toEqual([]);
  });
});

describe('CodexAppServerAdapter', () => {
  const fakeProvisioner: CodexHomeProvisioner = {
    provision: () => '/tmp/codex-home',
    readRefreshedAuth: () => undefined,
  };

  it('declares engine "codex" and exactly the writeGuard + postToolUseContext + midTurnSteer + richStream capabilities', () => {
    const adapter = new CodexAppServerAdapter(fakeProvisioner);
    expect(adapter.engine).toBe('codex');
    expect(new Set(adapter.capabilities)).toEqual(
      new Set(['writeGuard', 'postToolUseContext', 'midTurnSteer', 'richStream']),
    );
  });
});
