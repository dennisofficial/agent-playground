import type {
  CanUseTool,
  Options,
  PermissionResult,
} from '@anthropic-ai/claude-agent-sdk';
import { EnvService } from '@core/config/env/env.service';
import { Inject, Injectable } from '@nestjs/common';
import { ANTHROPIC_AGENT_SDK } from '../../_lib/esm/esm.module';
import { bashDenyReason, bashWriteReason, isInsideRoot } from './guard';
import type { RunWorkerArgs, WorkerEngine } from './worker-engine.port';

// The base set of built-in tools the worker may use. `tools` RESTRICTS the available set — unlike
// `allowedTools`, which only auto-approves. No WebSearch/Agent/MCP: a focused file+shell worker.
const WORKER_TOOLS = ['Read', 'Glob', 'Grep', 'Write', 'Edit', 'Bash'];
// A plan turn additionally gets ExitPlanMode — native plan mode's turn-ender, and (probed) the one
// place the FULL plan text reaches canUseTool headlessly: the CLI auto-writes the plan file
// internally, then calls ExitPlanMode with the plan in its input.
const PLAN_TOOLS = [...WORKER_TOOLS, 'ExitPlanMode'];
// Auto-approve safe reads. Write/Edit/Bash are intentionally absent so they fall through to
// canUseTool, where the project-root + bash boundary is re-applied.
const AUTO_APPROVE = ['Read', 'Glob', 'Grep'];

/**
 * Re-applies the safety boundary to the SDK's built-in tools: file writes must stay inside the
 * worktree, and bash commands must clear the deny-list. Every non-auto-approved tool call routes
 * here — a programmatic gate (no interactive surface), so it never blocks waiting on a human.
 *
 * A 'plan' turn runs under the SDK's NATIVE plan mode (`permissionMode: 'plan'`) — the agent plans
 * deeper there, and the CLI itself enforces read-only (validated by claude-plan-mode.ai.test.ts:
 * reads execute, writes never reach this gate). The model ends a plan by calling ExitPlanMode; we
 * capture `input.plan` via `onPlan` and DENY it — approving would flip the live session into
 * execution, which only the owner may do (by replying with mode 'execute'). The Write/Edit/bash
 * planning branches below are belt-and-braces behind the CLI's own enforcement.
 */
const makeCanUseTool =
  (
    planning: boolean,
    root: string,
    onPlan: (plan: string) => void,
  ): CanUseTool =>
  async (toolName, input): Promise<PermissionResult> => {
    if (toolName === 'ExitPlanMode') {
      if (typeof input.plan === 'string') onPlan(input.plan);
      return {
        behavior: 'deny',
        message:
          'Plan received and recorded — do not execute anything. End your turn now; your plan is being reviewed.',
      };
    }
    if (planning && (toolName === 'Write' || toolName === 'Edit')) {
      return {
        behavior: 'deny',
        message:
          'Planning is read-only — describe the change in your plan instead of writing it.',
      };
    }
    if (toolName === 'Bash') {
      const command = typeof input.command === 'string' ? input.command : '';
      const reason = bashDenyReason(command);
      if (reason) return { behavior: 'deny', message: `Refused: ${reason}.` };
      if (planning) {
        const write = bashWriteReason(command);
        if (write)
          return {
            behavior: 'deny',
            message: `Planning is read-only — ${write}.`,
          };
      }
    }
    if (toolName === 'Write' || toolName === 'Edit') {
      const path = typeof input.file_path === 'string' ? input.file_path : '';
      if (path && !isInsideRoot(path, root)) {
        return {
          behavior: 'deny',
          message: `Refused: "${path}" escapes the project directory.`,
        };
      }
    }
    return { behavior: 'allow', updatedInput: input };
  };

/** The Claude Agent SDK engine. The ESM-only SDK arrives via the EsmModule's lazy-loaded DI token. */
@Injectable()
export class ClaudeEngine implements WorkerEngine {
  readonly name = 'claude' as const;

  constructor(
    @Inject(ANTHROPIC_AGENT_SDK)
    private readonly sdk: typeof import('@anthropic-ai/claude-agent-sdk'),
    private readonly env: EnvService,
  ) {}

  async run({
    task,
    cwd,
    systemPrompt,
    sessionId,
    model,
    effort,
    mode,
    onEvent,
    signal,
  }: RunWorkerArgs) {
    // The SDK cancels via its own AbortController (it kills the child process); bridge our run signal to it.
    const abortController = new AbortController();
    if (signal) {
      if (signal.aborted) abortController.abort();
      else
        signal.addEventListener('abort', () => abortController.abort(), {
          once: true,
        });
    }
    const resolvedModel = model ?? this.env.get('WORKER_MODEL');
    const planMode = mode === 'plan';
    let capturedPlan = '';
    const options: Options = {
      cwd,
      systemPrompt,
      // SDK isolation: do NOT inherit the user's global ~/.claude config, skills, or hooks.
      settingSources: [],
      tools: planMode ? PLAN_TOOLS : WORKER_TOOLS,
      allowedTools: AUTO_APPROVE,
      canUseTool: makeCanUseTool(planMode, cwd, (plan) => {
        capturedPlan = plan;
      }),
      permissionMode: planMode ? 'plan' : 'default',
      abortController,
      ...(sessionId ? { resume: sessionId } : {}),
      ...(resolvedModel ? { model: resolvedModel } : {}),
      ...(effort ? { effort } : {}),
    };

    let result = '';
    let resolvedSession = sessionId;
    for await (const message of this.sdk.query({ prompt: task, options })) {
      if (message.type === 'system' && message.subtype === 'init') {
        resolvedSession = message.session_id;
      } else if (message.type === 'assistant') {
        for (const block of message.message.content as Array<{
          type: string;
          text?: string;
          name?: string;
        }>) {
          if (block.type === 'text' && block.text)
            onEvent({ kind: 'text', text: block.text });
          else if (block.type === 'tool_use' && block.name)
            onEvent({ kind: 'tool', name: block.name });
        }
      } else if (message.type === 'result') {
        resolvedSession = message.session_id;
        if (message.subtype === 'success') result = message.result;
        else throw new Error(`Claude worker ended: ${message.subtype}`);
      }
    }

    // On a plan turn the substance is the captured plan, not the model's closing summary ("the
    // plan has been recorded and is ready for review" — probed). Prefer the plan as the report.
    const summary = (planMode && capturedPlan) || result || '(no summary)';
    onEvent({ kind: 'result', text: summary });
    return { result: summary, sessionId: resolvedSession };
  }
}
