import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { CodexClient } from './codex-client.js';
import type { CodexApprovalRequest, CodexEvent } from './types.js';

// Vitest runs from the package root, so the fixture resolves off cwd (avoids import.meta, which this
// package's CommonJS-resolved TS config disallows).
const FAKE_SERVER = join(process.cwd(), 'test/fixtures/fake-app-server.mjs');

function makeClient(): CodexClient {
  return new CodexClient({
    codexHome: '/tmp/codex-sdk-test-home',
    codexPathOverride: process.execPath,
    args: [FAKE_SERVER],
  });
}

function isSubsequence(types: string[], expected: string[]): boolean {
  let i = 0;
  for (const t of types) {
    if (t === expected[i]) i++;
    if (i === expected.length) return true;
  }
  return i === expected.length;
}

async function waitFor(cond: () => boolean, timeoutMs = 5_000): Promise<void> {
  const start = Date.now();
  while (!cond()) {
    if (Date.now() - start > timeoutMs) throw new Error('waitFor timed out');
    await new Promise((r) => setTimeout(r, 5));
  }
}

describe('CodexClient', () => {
  let client: CodexClient;

  afterEach(async () => {
    await client.close();
  });

  it('drives the happy path: init -> startThread -> startTurn with typed events', async () => {
    client = makeClient();
    await client.init();
    const { threadId } = await client.startThread({ cwd: '/tmp' });

    const events: CodexEvent[] = [];
    const result = await client.startTurn(threadId, [{ type: 'text', text: 'hello' }], {
      onEvent: (e) => events.push(e),
    });

    const types = events.map((e) => e.type);
    expect(
      isSubsequence(types, [
        'turnStarted',
        'itemStarted',
        'agentMessageDelta',
        'tokenUsageUpdated',
        'turnCompleted',
      ]),
    ).toBe(true);
    expect(types).toContain('itemCompleted');
    expect(result.status).toBe('completed');
    // Regression guard for the turn/started `{turn: {id}}` shape and the tokenUsage.total
    // camelCase field parsing — both were silently wrong against a real server before.
    expect(result.turnId).toBe('turn_test_1');
    expect(result.usage).toEqual({
      inputTokens: 10,
      cachedInputTokens: 2,
      outputTokens: 5,
      reasoningOutputTokens: 3,
      totalTokens: 15,
    });
    expect(result.authHomePath).toBe('/tmp/codex-sdk-test-home');
  });

  it('routes approval requests to onApproval and reflects a decline in the stream', async () => {
    client = makeClient();
    await client.init();
    const { threadId } = await client.startThread({ cwd: '/tmp' });

    const events: CodexEvent[] = [];
    let captured: CodexApprovalRequest | undefined;
    const result = await client.startTurn(threadId, [{ type: 'text', text: 'trigger-approval' }], {
      onEvent: (e) => events.push(e),
      onApproval: (req) => {
        captured = req;
        return 'decline';
      },
    });

    expect(captured?.kind).toBe('fileChange');
    const completed = events.filter(
      (e): e is Extract<CodexEvent, { type: 'itemCompleted' }> => e.type === 'itemCompleted',
    );
    const fileChange = completed.find((e) => e.item.type === 'fileChange');
    expect(fileChange?.item.status).toBe('declined');
    expect(result.status).toBe('completed');
  });

  it('answers permissions approvals with a granted permissions response shape', async () => {
    client = makeClient();
    await client.init();
    const { threadId } = await client.startThread({ cwd: '/tmp' });

    const events: CodexEvent[] = [];
    let captured: CodexApprovalRequest | undefined;
    const result = await client.startTurn(
      threadId,
      [{ type: 'text', text: 'trigger-permissions' }],
      {
        onEvent: (e) => events.push(e),
        onApproval: (req) => {
          captured = req;
          return 'accept';
        },
      },
    );

    expect(captured?.kind).toBe('permissions');
    const message = events.find(
      (e): e is Extract<CodexEvent, { type: 'itemCompleted' }> => e.type === 'itemCompleted',
    );
    expect(message?.item.text).toBe('permission-granted');
    expect(result.status).toBe('completed');
  });

  it('steers the live turn mid-flight', async () => {
    client = makeClient();
    await client.init();
    const { threadId } = await client.startThread({ cwd: '/tmp' });

    const events: CodexEvent[] = [];
    let liveTurnId: string | undefined;
    const done = client.startTurn(threadId, [{ type: 'text', text: 'trigger-steer' }], {
      onEvent: (e) => {
        events.push(e);
        if (e.type === 'turnStarted') liveTurnId = e.turnId;
      },
    });

    await waitFor(() => liveTurnId !== undefined);
    await client.steer(threadId, liveTurnId!, [{ type: 'text', text: 'steered!' }]);
    const result = await done;

    const delta = events.find(
      (e): e is Extract<CodexEvent, { type: 'agentMessageDelta' }> =>
        e.type === 'agentMessageDelta',
    );
    expect(delta?.delta).toContain('steered!');
    expect(result.status).toBe('completed');
  });

  it('passes effort through verbatim without clamping xhigh', async () => {
    client = makeClient();
    await client.init();
    const { threadId } = await client.startThread({ cwd: '/tmp' });

    const events: CodexEvent[] = [];
    await client.startTurn(
      threadId,
      [{ type: 'text', text: 'hello' }],
      { onEvent: (e) => events.push(e) },
      { effort: 'xhigh' },
    );

    const started = events.find(
      (e): e is Extract<CodexEvent, { type: 'turnStarted' }> => e.type === 'turnStarted',
    );
    expect((started?.raw as { effort?: string }).effort).toBe('xhigh');
  });

  it('sends turn/start sandbox as a discriminated sandboxPolicy object, not a flat string', async () => {
    client = makeClient();
    await client.init();
    const { threadId } = await client.startThread({ cwd: '/tmp' });

    const events: CodexEvent[] = [];
    await client.startTurn(
      threadId,
      [{ type: 'text', text: 'hello' }],
      { onEvent: (e) => events.push(e) },
      { sandbox: 'workspaceWrite' },
    );

    const started = events.find(
      (e): e is Extract<CodexEvent, { type: 'turnStarted' }> => e.type === 'turnStarted',
    );
    expect((started?.raw as { sandboxPolicy?: { type?: string } }).sandboxPolicy).toEqual({
      type: 'workspaceWrite',
      writableRoots: [],
      networkAccess: true,
      excludeTmpdirEnvVar: false,
      excludeSlashTmp: false,
    });
  });
});
