import { CodexClient } from '@workspace/codex-sdk';
import type {
  CodexApprovalDecision,
  CodexApprovalRequest,
  CodexEffort,
  CodexTokenUsage,
  CodexTurnHandlers,
} from '@workspace/codex-sdk';
import type { AdapterRunArgs, EngineAdapter, EngineCapability, EngineLocalHooks } from '../port.js';
import type { EngineAuth, EngineHomeKey, EngineRunResult, EngineUsage, ReasoningEffort } from '../types.js';
import { EngineAuthError, isAuthErrorMessage } from '../types.js';
import { mapCodexEvent, type MapCodexEventCtx } from './map-codex-event.js';

/** An MCP host-tool bridge to render into the provisioned `CODEX_HOME`'s `config.toml`. Out of scope for
 *  thread 2 (no `writeGuard`/bridge capability wired yet) — modeled so a later pass can pass one through. */
export interface CodexBridgeSpec {
  serverPath: string;
  toolNames: string[];
  env: Record<string, string>;
}

/**
 * The package-owned seam to the Atlas-side Codex home/auth machinery. The backend supplies the impl
 * (wrapping `ensureCodexAuthHome`/`readCodexAuthHome`) so this adapter stays free of backend types.
 */
export interface CodexHomeProvisioner {
  /** Materialize the isolated `CODEX_HOME` dir (seeded `auth.json` + `config.toml`) and return its path. */
  provision(a: { sandboxKey: EngineHomeKey; auth: EngineAuth; bridge?: CodexBridgeSpec }): string;
  /** The post-turn rotated auth secret if Codex rewrote `auth.json`, else undefined (unchanged). */
  readRefreshedAuth(sandboxKey: EngineHomeKey): string | undefined;
}

/** Codex's effort has no `'max'`; clamp it to the ceiling (`'xhigh'`). Every other value passes through
 *  verbatim — an Atlas caller's `xhigh` must reach `startTurn` as `xhigh`, unchanged. */
function toCodexEffort(e?: ReasoningEffort): CodexEffort | undefined {
  if (!e) return undefined;
  return e === 'max' ? 'xhigh' : e;
}

/**
 * The Codex {@link EngineAdapter}: the ONE place Atlas maps to/from the `codex app-server` protocol via
 * `@workspace/codex-sdk`. One `CodexClient` (one app-server subprocess) per `run()` — no cross-turn caching
 * this pass. Capabilities are `writeGuard` + `postToolUseContext` + `midTurnSteer` + `richStream`: write-guard
 * via `onApproval` returning `decline`, and both the svc-nudge post-tool-context rule and the leg-rotation
 * mid-turn steer are committed through `CodexClient.steer`. `holdTimer`/`subagents` remain honestly
 * undeclared — the 0.137.0 app-server surface exposes no observable equivalent to Claude's held-open
 * background-task hold-timer or a controllable subagent surface this pass.
 */
export class CodexAppServerAdapter implements EngineAdapter {
  readonly engine = 'codex' as const;
  readonly capabilities: ReadonlySet<EngineCapability> = new Set<EngineCapability>([
    'writeGuard',
    'postToolUseContext',
    'midTurnSteer',
    'richStream',
  ]);

  constructor(private readonly provisioner: CodexHomeProvisioner) {}

  async run(args: AdapterRunArgs): Promise<EngineRunResult> {
    // The caller (EngineCore) owns auth resolution and guarantees a secret before calling in; this is a
    // cheap assertion, not the auth-resolution policy.
    if (!args.auth) throw new Error('CodexAppServerAdapter.run: auth is required');

    const codexHome = this.provisioner.provision({ sandboxKey: args.sandboxKey, auth: args.auth });
    const client = new CodexClient({ codexHome });
    await client.init();

    try {
      // Model left UNSET — the subscription account's default is used (subscription accounts reject an
      // explicit model). `resumeThread` takes no `cwd` (the thread already knows its worktree).
      const { threadId } = args.sessionId
        ? await client.resumeThread(args.sessionId, { sandbox: 'dangerFullAccess' })
        : await client.startThread({ cwd: args.cwd, sandbox: 'dangerFullAccess' });

      // The app-server's thread/start RPC returns the id synchronously, so surface the resume handle at
      // once (before the turn) for mid-turn halt recovery.
      args.onEvent?.({ kind: 'session', sessionId: threadId });

      // Codex has no system-prompt option: a FRESH thread gets the persona as a first-turn preamble; a
      // RESUMED thread already carries it in history.
      const inputText = args.sessionId ? args.task : `${args.systemPrompt}\n\n---\n\nTask: ${args.task}`;

      let resultText = '';
      const mapCtx: MapCodexEventCtx = {
        cwd: args.cwd,
        richStream: !!args.richStream,
        onResult: (text) => {
          resultText = text;
        },
      };

      // Per-turn hook-fire state (fresh per `run()` call, mirroring the Claude adapter's per-turn closures —
      // no cross-turn leakage). `contextTokens` is refreshed from the app-server's own `tokenUsageUpdated`
      // notifications (Codex reports no per-call usage any other way); `firedRotationLevel` level-latches the
      // leg-rotation steer exactly like the Claude path (engine-core.ts's main-agent round-trip tracker).
      let contextTokens = 0;
      let firedRotationLevel = -1;

      // svc-nudge parity: a completed Bash command that matches the rule gets its nudge delivered via a
      // mid-turn steer (Claude delivers the SAME rule as a PostToolUse `additionalContext` — different
      // transport, identical behavioral effect: the agent sees the nudge at the next round-trip).
      const maybeSteerSvcNudge = (threadId: string, turnId: string, item: Record<string, unknown>): void => {
        if (!args.hooks?.postToolUseContext) return;
        const command = typeof item.command === 'string' ? item.command : '';
        const text = args.hooks.postToolUseContext('Bash', { command }, contextTokens);
        if (!text) return;
        void client.steer(threadId, turnId, [{ type: 'text', text }]).catch(() => {});
      };

      // leg-rotation parity: level-latch on the SAME soft/reminder-band algorithm the Claude path uses,
      // driven off Codex's own cumulative token-usage notifications instead of the SDK's per-call usage.
      const maybeSteerRotation = (threadId: string, turnId: string): void => {
        const rotation = args.hooks?.rotation;
        if (!rotation || contextTokens < rotation.softTokens) return;
        const level = Math.floor((contextTokens - rotation.softTokens) / rotation.reminderDeltaTokens);
        if (level <= firedRotationLevel) return;
        const isFirst = firedRotationLevel < 0;
        firedRotationLevel = level;
        const text = isFirst ? rotation.softText : rotation.reminderText;
        void client.steer(threadId, turnId, [{ type: 'text', text }]).catch(() => {});
      };

      const handlers: CodexTurnHandlers = {
        onEvent: (e) => {
          if (e.type === 'tokenUsageUpdated') {
            contextTokens = (e.usage.inputTokens ?? 0) + (e.usage.cachedInputTokens ?? 0);
            maybeSteerRotation(e.threadId, e.turnId);
          } else if (e.type === 'itemCompleted' && e.item.type === 'command_execution') {
            maybeSteerSvcNudge(e.threadId, e.turnId, e.item);
          }
          for (const mapped of mapCodexEvent(e, mapCtx)) args.onEvent?.(mapped);
        },
        onApproval: async (req: CodexApprovalRequest): Promise<CodexApprovalDecision> => {
          // Unset when the turn carries no write-guard predicate (e.g. an execute turn with no root
          // confinement configured), so this defaults to 'accept'.
          if (!args.hooks?.writeGuard) return 'accept';
          const verdict = args.hooks.writeGuard(req.kind, req.raw);
          return verdict.allow ? 'accept' : 'decline';
        },
      };

      const result = await client.startTurn(threadId, [{ type: 'text', text: inputText }], handlers, {
        effort: toCodexEffort(args.modelReasoningEffort),
        sandbox: 'dangerFullAccess',
        signal: args.signal,
      });

      if (result.status === 'failed') {
        const message = result.error?.message ?? 'Codex turn failed';
        if (isAuthErrorMessage(message)) throw new EngineAuthError(message, threadId, 'codex');
        throw new Error(message);
      }

      // 'completed' or 'interrupted': the SDK resolved cleanly (a cooperative abort settles with a partial
      // result rather than throwing). Return whatever summary text was accumulated.
      const summary = resultText || '(no summary)';
      args.onEvent?.({ kind: 'result', text: summary });

      const usage = mapUsage(result.usage);
      const refreshedAuthSecret = args.persistAuthRefresh
        ? this.provisioner.readRefreshedAuth(args.sandboxKey)
        : undefined;

      return {
        result: summary,
        sessionId: threadId,
        ...(usage ? { usage } : {}),
        ...(refreshedAuthSecret ? { refreshedAuthSecret } : {}),
      };
    } finally {
      await client.close();
    }
  }
}

/** Map Codex's cumulative token usage to the vendor-neutral shape. Reasoning stays SEPARATE from output
 *  (mirroring the legacy `runCodex`); cache-read and reasoning are omitted when zero. No model id — Codex
 *  never reports one. */
function mapUsage(usage: CodexTokenUsage | undefined): EngineUsage | undefined {
  if (!usage) return undefined;
  const cacheReadTokens = usage.cachedInputTokens ?? 0;
  const reasoningTokens = usage.reasoningOutputTokens ?? 0;
  return {
    inputTokens: usage.inputTokens,
    outputTokens: usage.outputTokens,
    ...(cacheReadTokens > 0 ? { cacheReadTokens } : {}),
    ...(reasoningTokens > 0 ? { reasoningTokens } : {}),
  };
}
