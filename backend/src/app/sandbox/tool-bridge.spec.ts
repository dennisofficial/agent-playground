/**
 * R1 GATE TEST — Tool Bridge live contract
 *
 * Proves the bidirectional stdin/stdout frame protocol end-to-end with a local subprocess,
 * WITHOUT requiring a real LLM or Docker:
 *
 * 1. A thread-owned host dispatcher runs a turn via a fake entrypoint subprocess.
 * 2. The fake entrypoint reads the turn spec from stdin, emits a `tool_request` frame on stdout.
 * 3. The host dispatches the request through `ToolBridgeHost`, writes a `tool_response` on stdin.
 * 4. The fake entrypoint reads the response, uses it in the `final` frame.
 * 5. The host runner resolves with the final result — the turn "continues" using the tool data.
 *
 * Cross-thread scope denial:
 * 6. A second invocation with `args.threadId` pointing to a DIFFERENT thread is denied with an
 *    error frame (scope violation).
 *
 * No Docker, no LLM key, no Postgres. Pure transport + dispatch + scoping.
 */
import { writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { describe, expect, it, beforeAll } from 'vitest';
import { ToolBridgeHost } from '../engine/tool-bridge-host';
import type { ToolBridgeOptions, EngineRunResult } from '../engine/engine.types';

// ── Fake entrypoint ────────────────────────────────────────────────────────────────────────────

/**
 * A minimal fake engine-entrypoint script that exercises the FULL bidirectional protocol without
 * a real LLM.  It:
 *   1. Reads ONE NDJSON line from stdin (the turn spec).
 *   2. If `toolBridgeTools` is present, emits a `tool_request` for the first listed tool, passing
 *      `{ threadId: spec.threadIdHint }` as args (so the host can test scope enforcement).
 *   3. Reads a `tool_response`/`tool_error` reply from stdin.
 *   4. Emits a `final` frame whose `result` field contains the tool result (or error message).
 *   5. Exits.
 *
 * `spec.threadIdHint` is an extra field the test injects to control what threadId the tool request
 * carries, allowing the cross-thread denial test.
 */
const FAKE_ENTRYPOINT_SRC = `
import { createInterface } from 'readline';

function emit(frame) {
  process.stdout.write(JSON.stringify(frame) + '\\n');
}

async function readLine(rl) {
  return new Promise((resolve, reject) => {
    rl.once('line', resolve);
    rl.once('error', reject);
    rl.once('close', () => resolve(''));
  });
}

const rl = createInterface({ input: process.stdin });

// Step 1: read the turn spec (first line).
const specLine = await readLine(rl);
const spec = JSON.parse(specLine);

if (spec.toolBridgeTools && spec.toolBridgeTools.length > 0) {
  const toolName = spec.toolBridgeTools[0];
  const reqId = 'test-req-id-001';

  // Step 2: emit tool_request.
  emit({ t: 'tool_request', id: reqId, name: toolName, args: { threadId: spec.threadIdHint ?? spec.sandboxKey } });

  // Step 3: read the tool_response/tool_error from stdin.
  const respLine = await readLine(rl);
  const resp = JSON.parse(respLine);

  if (resp.t === 'tool_response') {
    // Step 4: emit final with the tool result.
    emit({ t: 'final', r: { result: 'used: ' + JSON.stringify(resp.result), sessionId: 'fake-session-001' } });
  } else {
    // tool_error: the request was denied — emit the error as an error frame.
    emit({ t: 'error', message: resp.message });
    process.exitCode = 1;
  }
} else {
  // No bridge: just echo back.
  emit({ t: 'final', r: { result: 'echo-no-bridge', sessionId: 'fake-session-000' } });
}

rl.close();
`;

// Write the fake entrypoint to a temp file once for all tests in this file.
let fakeEntrypointPath: string;

beforeAll(() => {
  fakeEntrypointPath = join(tmpdir(), `atlas-r1-gate-fake-entrypoint-${process.pid}.mjs`);
  writeFileSync(fakeEntrypointPath, FAKE_ENTRYPOINT_SRC, 'utf8');
});

// ── helpers ────────────────────────────────────────────────────────────────────────────────────

interface RunResult {
  result?: EngineRunResult;
  error?: string;
}

/**
 * Runs a turn against the fake entrypoint using the real `ToolBridgeHost` dispatch.
 * Returns the final EngineRunResult or the error message if the turn fails.
 */
async function runFakeTurn(opts: {
  toolBridge: ToolBridgeOptions;
  /** What threadId the fake entrypoint should put in the tool_request args (to test scoping). */
  requestedThreadId?: string;
}): Promise<RunResult> {
  const { toolBridge, requestedThreadId } = opts;

  const spec = {
    engine: 'claude',
    task: 'test task',
    cwd: '/tmp',
    systemPrompt: 'test',
    sandboxKey: 'test-sandbox',
    mode: 'execute',
    toolBridgeTools: Object.keys(toolBridge.tools),
    // Injected by the test to control what threadId the fake entrypoint sends in the request.
    threadIdHint: requestedThreadId ?? toolBridge.threadId,
  };

  const child = spawn(process.execPath, [fakeEntrypointPath], {
    stdio: ['pipe', 'pipe', 'pipe'],
  });

  let finalResult: EngineRunResult | undefined;
  let errorMsg: string | undefined;

  const host = new ToolBridgeHost(
    toolBridge,
    (line) => child.stdin.write(line),
    () => child.stdin.end(),
  );

  host.onFrame((frame) => {
    if (frame.t === 'final') finalResult = frame.r as EngineRunResult;
    else if (frame.t === 'error') errorMsg = frame.message;
  });

  // Write the turn spec as the first line.
  child.stdin.write(JSON.stringify(spec) + '\n');

  child.stdout.on('data', (chunk: Buffer) => host.feedChunk(chunk.toString('utf8')));
  child.stderr.on('data', (chunk: Buffer) => {
    // Suppress test noise but make visible on failure.
    process.stderr.write(`[fake-entrypoint] ${chunk.toString('utf8')}`);
  });

  await Promise.allSettled([
    new Promise<void>((resolve, reject) => {
      child.on('close', () => resolve());
      child.on('error', reject);
    }),
    host.closed,
  ]);

  host.flush();

  return { result: finalResult, error: errorMsg };
}

// ── Gate tests ─────────────────────────────────────────────────────────────────────────────────

describe('R1 Tool Bridge — live contract gate', () => {
  it('tool_request is dispatched, host returns correlated tool_response, turn continues with it', async () => {
    const threadId = 'thread-abc-123';
    const PIPELINE_STATE = { status: 'planning', tracks: 2 };

    const bridge: ToolBridgeOptions = {
      threadId,
      tools: {
        get_pipeline_state: async (_args) => PIPELINE_STATE,
      },
    };

    const { result, error } = await runFakeTurn({ toolBridge: bridge });

    expect(error).toBeUndefined();
    expect(result).toBeDefined();
    // The fake entrypoint embeds the tool response into the final result.
    expect(result!.result).toContain('used:');
    expect(result!.result).toContain('"status"');
    expect(result!.result).toContain('planning');
    expect(result!.sessionId).toBe('fake-session-001');
  }, 10_000);

  it('tool_request scoped to a DIFFERENT thread is denied with a scope-violation error', async () => {
    const owningThreadId = 'thread-abc-123';
    const intruderThreadId = 'thread-xyz-999';  // different thread

    const bridge: ToolBridgeOptions = {
      threadId: owningThreadId,
      tools: {
        get_pipeline_state: async (_args) => ({ status: 'should-not-reach' }),
      },
    };

    // The fake entrypoint will send threadId=intruderThreadId in the tool_request args.
    const { result, error } = await runFakeTurn({
      toolBridge: bridge,
      requestedThreadId: intruderThreadId,
    });

    // The host should deny the request → the fake entrypoint gets a tool_error → emits error frame.
    expect(result).toBeUndefined();
    expect(error).toBeDefined();
    expect(error).toMatch(/Thread scope violation/i);
    expect(error).toContain(intruderThreadId);
    expect(error).toContain(owningThreadId);
  }, 10_000);

  it('unknown tool name results in a tool_error (not a crash)', async () => {
    const threadId = 'thread-abc-123';

    // We declare an unknown tool name in toolBridgeTools so the fake entrypoint requests it,
    // but it's not in the dispatch table.
    const bridge: ToolBridgeOptions = {
      threadId,
      // Empty dispatch table — no tools actually implemented.
      tools: {},
    };

    // Override: make the spec include a tool name even though dispatch table is empty.
    const specWithUnknown = {
      engine: 'claude',
      task: 'test task',
      cwd: '/tmp',
      systemPrompt: 'test',
      sandboxKey: 'test-sandbox',
      mode: 'execute',
      toolBridgeTools: ['nonexistent_tool'],
      threadIdHint: threadId,
    };

    const child = spawn(process.execPath, [fakeEntrypointPath], {
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    let finalResult: EngineRunResult | undefined;
    let errorMsg: string | undefined;

    const host = new ToolBridgeHost(
      bridge,
      (line) => child.stdin.write(line),
      () => child.stdin.end(),
    );

    host.onFrame((frame) => {
      if (frame.t === 'final') finalResult = frame.r as EngineRunResult;
      else if (frame.t === 'error') errorMsg = frame.message;
    });

    child.stdin.write(JSON.stringify(specWithUnknown) + '\n');
    child.stdout.on('data', (chunk: Buffer) => host.feedChunk(chunk.toString('utf8')));

    await Promise.allSettled([
      new Promise<void>((resolve, reject) => {
        child.on('close', () => resolve());
        child.on('error', reject);
      }),
      host.closed,
    ]);
    host.flush();

    expect(finalResult).toBeUndefined();
    expect(errorMsg).toMatch(/Unknown tool/i);
  }, 10_000);

  it('ToolBridgeHost correctly correlates multiple concurrent tool_requests by id', async () => {
    /**
     * This test exercises the host-side correlation map directly, without a subprocess.
     * It feeds pre-crafted tool_request frames and verifies responses are dispatched correctly.
     */
    const threadId = 'thread-corr-test';
    const results: Array<{ name: string; result: unknown }> = [];

    let stdinWrites: string[] = [];

    const bridge: ToolBridgeOptions = {
      threadId,
      tools: {
        tool_a: async (_args) => 'result-a',
        tool_b: async (_args) => 'result-b',
      },
    };

    const host = new ToolBridgeHost(
      bridge,
      (line) => stdinWrites.push(line),
      () => { /* noop */ },
    );

    host.onFrame((frame) => {
      if (frame.t === 'final') results.push({ name: 'final', result: (frame as { r: unknown }).r });
    });

    // Feed two tool_requests interleaved, then a final.
    host.feedChunk(JSON.stringify({ t: 'tool_request', id: 'id-1', name: 'tool_a', args: { threadId } }) + '\n');
    host.feedChunk(JSON.stringify({ t: 'tool_request', id: 'id-2', name: 'tool_b', args: { threadId } }) + '\n');

    // Give the async dispatchers time to complete.
    await new Promise((r) => setTimeout(r, 50));

    // Verify the host wrote two responses to stdin.
    expect(stdinWrites.length).toBe(2);
    const parsedWrites = stdinWrites.map((s) => JSON.parse(s));
    const writeById = Object.fromEntries(parsedWrites.map((w: { id: string }) => [w.id, w]));
    expect(writeById['id-1']).toMatchObject({ t: 'tool_response', id: 'id-1', result: 'result-a' });
    expect(writeById['id-2']).toMatchObject({ t: 'tool_response', id: 'id-2', result: 'result-b' });

    // Feed the final frame to close the turn.
    host.feedChunk(JSON.stringify({ t: 'final', r: { result: 'done', sessionId: 's1' } }) + '\n');
    await host.closed;
    expect(results).toHaveLength(1);
    expect(results[0]!.result).toMatchObject({ result: 'done' });
  }, 10_000);
});
