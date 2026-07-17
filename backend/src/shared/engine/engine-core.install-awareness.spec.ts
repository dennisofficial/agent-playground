/**
 * Unit tests for the install-awareness PostToolUse hook (see the `installAwarenessEnabled` branch in
 * `EngineCore.runClaude`). Drives the ACTUAL registered callback end-to-end (regex gate -> bridgeCall ->
 * timeout race -> additionalContext), not just the pure `detectInstallCommand` helper (that's covered in
 * `../prompt-kit/jit/install-awareness.spec.ts`).
 */
import { rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it, vi } from 'vitest';
import { agentMessage } from '../prompt-kit/message';
import { EngineCore } from './engine-core';
import type { EngineHomeKey } from './engine-home';
import { INTERNAL_PROFILE_AWARENESS_TOOL } from './engine.types';

const HOME_ROOT = join(tmpdir(), `atlas-install-awareness-spec-${process.pid}`);
afterAll(() => rmSync(HOME_ROOT, { recursive: true, force: true }));

const TEST_KEY: EngineHomeKey = {
  orgId: 'acme',
  repoId: 'atlas',
  jobId: 'feat',
  type: 'build',
};

/** A fake Claude SDK whose `query` records the options it was called with and yields a success. */
function fakeClaudeSdk() {
  const captured: { options?: Record<string, unknown> } = {};
  const sdk = {
    query: ({ options }: { prompt: string; options: Record<string, unknown> }) => {
      captured.options = options;
      return (async function* () {
        yield { type: 'system', subtype: 'init', session_id: 'sess-1' };
        yield {
          type: 'result',
          subtype: 'success',
          session_id: 'sess-1',
          result: 'done',
          usage: { input_tokens: 10, output_tokens: 4 },
          total_cost_usd: 0.01,
        };
      })();
    },
  } as unknown as typeof import('@anthropic-ai/claude-agent-sdk');
  return { sdk, captured };
}
/** A fake Codex SDK — unused by these tests but required by the EngineCore constructor. */
function fakeCodexSdk() {
  return { sdk: {} as unknown as typeof import('@openai/codex-sdk') };
}

/** Pulls the Bash PostToolUse callbacks array out of the captured options (empty if none registered). */
function bashHooks(options: Record<string, unknown>): Array<(input: unknown) => Promise<unknown>> {
  const hooks = options.hooks as
    | {
        PostToolUse?: Array<{
          matcher: string;
          hooks: Array<(input: unknown) => Promise<unknown>>;
        }>;
      }
    | undefined;
  return hooks?.PostToolUse?.[0]?.hooks ?? [];
}

async function runWithBridgeCall(
  bridgeCall?: (name: string, args: Record<string, unknown>) => Promise<unknown>,
) {
  const { sdk, captured } = fakeClaudeSdk();
  const core = new EngineCore(sdk, fakeCodexSdk().sdk, { homeRoot: HOME_ROOT });
  await core.run({
    engine: 'claude',
    task: agentMessage('do it'),
    cwd: '/tmp/wt',
    systemPrompt: agentMessage('persona'),
    sandboxKey: TEST_KEY,
    mode: 'execute',
    auth: { secret: 'oauth-tok' },
    model: 'claude-x',
    ...(bridgeCall ? { bridgeCall } : {}),
  });
  return captured.options!;
}

describe('install-awareness PostToolUse hook', () => {
  it('pnpm add eslint + bridgeCall resolving "TEXT" -> additionalContext "TEXT", called with {command, sessionType}', async () => {
    const bridgeCall = vi.fn(async () => 'TEXT');
    const options = await runWithBridgeCall(bridgeCall);
    const hooks = bashHooks(options);
    expect(hooks.length).toBeGreaterThan(0);
    const results = await Promise.all(
      hooks.map((h) => h({ tool_name: 'Bash', tool_input: { command: 'pnpm add eslint' } })),
    );
    const hit = results.find(
      (r) =>
        (r as { hookSpecificOutput?: { additionalContext?: string } })?.hookSpecificOutput
          ?.additionalContext === 'TEXT',
    );
    expect(hit).toBeTruthy();
    expect(bridgeCall).toHaveBeenCalledWith(INTERNAL_PROFILE_AWARENESS_TOOL, {
      command: 'pnpm add eslint',
      sessionType: 'build',
    });
  });

  it('non-install command -> {} from every hook, bridgeCall NOT called', async () => {
    const bridgeCall = vi.fn(async () => 'TEXT');
    const options = await runWithBridgeCall(bridgeCall);
    const hooks = bashHooks(options);
    const results = await Promise.all(
      hooks.map((h) => h({ tool_name: 'Bash', tool_input: { command: 'ls -la' } })),
    );
    for (const r of results) expect(r).toEqual({});
    expect(bridgeCall).not.toHaveBeenCalled();
  });

  it('bridgeCall resolves null -> {}', async () => {
    const bridgeCall = vi.fn(async () => null);
    const options = await runWithBridgeCall(bridgeCall);
    const hooks = bashHooks(options);
    const results = await Promise.all(
      hooks.map((h) => h({ tool_name: 'Bash', tool_input: { command: 'pnpm add eslint' } })),
    );
    for (const r of results) expect(r).toEqual({});
  });

  it('bridgeCall throws -> {} (fail-silent)', async () => {
    const bridgeCall = vi.fn(async () => {
      throw new Error('boom');
    });
    const options = await runWithBridgeCall(bridgeCall);
    const hooks = bashHooks(options);
    const results = await Promise.all(
      hooks.map((h) => h({ tool_name: 'Bash', tool_input: { command: 'pnpm add eslint' } })),
    );
    for (const r of results) expect(r).toEqual({});
  });

  it('bridgeCall undefined -> install-awareness callback never fires (no additionalContext for an install command)', async () => {
    const options = await runWithBridgeCall(undefined);
    const hooks = bashHooks(options);
    const results = await Promise.all(
      hooks.map((h) => h({ tool_name: 'Bash', tool_input: { command: 'pnpm add eslint' } })),
    );
    for (const r of results) expect(r).toEqual({});
  });

  it('bridgeCall that never resolves within the 5s bound -> {} (timeout race)', async () => {
    vi.useFakeTimers();
    try {
      const bridgeCall = vi.fn(() => new Promise<string>(() => {}));
      const options = await runWithBridgeCall(bridgeCall);
      const hooks = bashHooks(options);
      const pending = Promise.all(
        hooks.map((h) => h({ tool_name: 'Bash', tool_input: { command: 'pnpm add eslint' } })),
      );
      await vi.advanceTimersByTimeAsync(5_000);
      const results = await pending;
      for (const r of results) expect(r).toEqual({});
    } finally {
      vi.useRealTimers();
    }
  });
});
