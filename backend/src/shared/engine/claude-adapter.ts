import type {
  AdapterRunArgs,
  EngineAdapter,
  EngineCapability,
  EngineLocalHooks,
  EngineRunResult,
} from '@workspace/agent-engine';
import { svcNudgeRule, svcNudgeShouldFire } from '../prompt-kit/jit';
import type { RunEngineArgs } from './engine.types';

/** The exact signature of `EngineCore`'s private `runClaude` — bound and handed in per turn. */
type RunClaudeFn = (
  args: RunEngineArgs,
  extraClaudeOptions?: Record<string, unknown>,
  bridgeToolNames?: string[],
  hooks?: EngineLocalHooks,
) => Promise<EngineRunResult>;

/**
 * The Claude {@link EngineAdapter}. It is a thin per-turn wrapper around `EngineCore`'s existing `runClaude`:
 * `runClaude` (and all its prompt-kit / LSP / subagent deps) stays in `engine-core.ts`, so this adapter keeps
 * the FULL {@link RunEngineArgs} in scope — everything the slim {@link AdapterRunArgs} port contract drops
 * (`steerInput`/`rotationNudge`/`skills`/`grantedSkills`/`repoConventions`/`persistAuthRefresh`/…) still reaches
 * `runClaude` unchanged. Its one job beyond that pass-through is to build the {@link EngineLocalHooks} that
 * `runClaude` reads for its capability-gated JIT primitives — behaviour-identical to the logic that used to be
 * inline in `runClaude` (thread 3 centralizes hook-building in `EngineCore`).
 */
export class ClaudeAdapter implements EngineAdapter {
  readonly engine = 'claude' as const;
  readonly capabilities: ReadonlySet<EngineCapability> =
    new Set<EngineCapability>([
      'postToolUseContext',
      'writeGuard',
      'midTurnSteer',
      'holdTimer',
      'subagents',
      'richStream',
    ]);

  constructor(
    private readonly runClaudeFn: RunClaudeFn,
    private readonly fullArgs: RunEngineArgs,
    private readonly extraClaudeOptions?: Record<string, unknown>,
    private readonly bridgeToolNames?: string[],
  ) {}

  run(_adapterArgs: AdapterRunArgs): Promise<EngineRunResult> {
    return this.runClaudeFn(
      this.fullArgs,
      this.extraClaudeOptions,
      this.bridgeToolNames,
      this.buildHooks(),
    );
  }

  /**
   * Assemble this turn's {@link EngineLocalHooks}. The `steer` channel is ALWAYS a live-mutable stub: `runClaude`
   * replaces its `.push` with the real streaming-input injection once the open stream exists, so the bg-task-cap
   * notice (and any thread-3 steer) always has an object to mutate rather than being silently dropped. The
   * `postToolUseContext` closure carries the atlas-svc nudge — built only when the `svc-nudge` rule is enabled,
   * with its OWN per-turn throttle cursor (`ClaudeAdapter` is constructed fresh per turn). `writeGuard` is left
   * unset for Claude (no rule needs it yet — the worktree boundary already lives in `makeCanUseTool`).
   */
  private buildHooks(): EngineLocalHooks {
    const hooks: EngineLocalHooks = { steer: { push: () => {} } };
    if (svcNudgeRule.enabled) {
      const deltaTokens = svcNudgeRule.throttle!.deltaTokens;
      let lastSvcNudgeTokens: number | null = null;
      hooks.postToolUseContext = (toolName, input, tokens): string | null => {
        if (toolName !== 'Bash') return null;
        const command = (input as { command?: unknown } | undefined)?.command;
        const cmd = typeof command === 'string' ? command : '';
        if (
          svcNudgeRule.trigger.kind !== 'tool-match' ||
          !svcNudgeRule.trigger.match(cmd)
        )
          return null;
        // First matching command always fires; then at most once per delta of context growth.
        if (!svcNudgeShouldFire(lastSvcNudgeTokens, tokens, deltaTokens))
          return null;
        lastSvcNudgeTokens = tokens;
        return svcNudgeRule.render({ command: cmd });
      };
    }
    return hooks;
  }
}
