import type {
  AdapterRunArgs,
  EngineAdapter,
  EngineCapability,
  EngineLocalHooks,
  EngineRunResult,
} from '@workspace/agent-engine';
import { svcNudgeRule, svcNudgeShouldFire } from '../prompt-kit/jit';
import type { RunEngineArgs } from './engine.types';

type RunClaudeFn = (
  args: RunEngineArgs,
  extraClaudeOptions?: Record<string, unknown>,
  bridgeToolNames?: string[],
  hooks?: EngineLocalHooks,
) => Promise<EngineRunResult>;

export class ClaudeAdapter implements EngineAdapter {
  readonly engine = 'claude' as const;
  readonly capabilities: ReadonlySet<EngineCapability> = new Set<EngineCapability>([
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

  private buildHooks(): EngineLocalHooks {
    const hooks: EngineLocalHooks = { steer: { push: () => {} } };
    if (svcNudgeRule.enabled) {
      const deltaTokens = svcNudgeRule.throttle!.deltaTokens;
      let lastSvcNudgeTokens: number | null = null;
      hooks.postToolUseContext = (toolName, input, tokens): string | null => {
        if (toolName !== 'Bash') return null;
        const command = (input as { command?: unknown } | undefined)?.command;
        const cmd = typeof command === 'string' ? command : '';
        if (svcNudgeRule.trigger.kind !== 'tool-match' || !svcNudgeRule.trigger.match(cmd))
          return null;
        if (!svcNudgeShouldFire(lastSvcNudgeTokens, tokens, deltaTokens)) return null;
        lastSvcNudgeTokens = tokens;
        return svcNudgeRule.render({ command: cmd });
      };
    }
    return hooks;
  }
}
