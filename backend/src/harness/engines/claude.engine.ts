import type {
  CanUseTool,
  Options,
  PermissionResult,
} from '@anthropic-ai/claude-agent-sdk';
import { EnvService } from '@core/config/env/env.service';
import { engineHomeDir } from './engine-home';
import { Inject, Injectable } from '@nestjs/common';
import { ANTHROPIC_AGENT_SDK } from '../../_lib/esm/esm.module';
import { bashDenyReason, bashWriteReason, isInsideRoot } from './guard';
import { CLAUDE_DENIALS } from './engine.prompts';
import {
  EWorkerEngineName,
  RunWorkerArgs,
  WorkerEngine,
  WorkerQuestion,
} from './worker-engine.port';

// The base set of built-in tools the worker may use. `tools` RESTRICTS the available set — unlike
// `allowedTools`, which only auto-approves. No WebSearch/Agent/MCP: a focused file+shell worker.
const WORKER_TOOLS = ['Read', 'Glob', 'Grep', 'Write', 'Edit', 'Bash'];
// A plan turn additionally gets ExitPlanMode — native plan mode's turn-ender, and (probed) the one
// place the FULL plan text reaches canUseTool headlessly: the CLI auto-writes the plan file
// internally, then calls ExitPlanMode with the plan in its input — and AskUserQuestion, the
// clarifying-question tool (restricting `tools` without listing it silently removes it; that was
// why sessions never asked anything). Plan turns only: execute turns put questions in the report.
const PLAN_TOOLS = [...WORKER_TOOLS, 'ExitPlanMode', 'AskUserQuestion'];
// An 'investigate' turn is read-only like plan but WITHOUT the native plan ceremony: it gets the read
// tools only — no Write/Edit (so there's nothing to deny), and no ExitPlanMode/AskUserQuestion (it
// answers directly instead of producing a plan or relaying questions). Bash stays for read commands
// (git log / grep); its write commands are still denied in canUseTool when the turn is read-only.
const INVESTIGATE_TOOLS = ['Read', 'Glob', 'Grep', 'Bash'];
// Auto-approve safe reads. Write/Edit/Bash are intentionally absent so they fall through to
// canUseTool, where the project-root + bash boundary is re-applied.
const AUTO_APPROVE = ['Read', 'Glob', 'Grep'];

/** Defensive mapping from the SDK's AskUserQuestion input to the seam's WorkerQuestion shape —
 * tolerate missing/odd fields rather than dropping a turn's questions on a schema drift. */
function normalizeQuestions(raw: unknown[]): WorkerQuestion[] {
  return raw.flatMap((q) => {
    if (!q || typeof q !== 'object') return [];
    const r = q as Record<string, unknown>;
    if (typeof r.question !== 'string' || !r.question.trim()) return [];
    const options = Array.isArray(r.options)
      ? r.options.flatMap((o) => {
          if (!o || typeof o !== 'object') return [];
          const opt = o as Record<string, unknown>;
          if (typeof opt.label !== 'string' || !opt.label.trim()) return [];
          return [
            {
              label: opt.label,
              ...(typeof opt.description === 'string' && opt.description
                ? { description: opt.description }
                : {}),
            },
          ];
        })
      : [];
    return [
      {
        question: r.question,
        ...(typeof r.header === 'string' && r.header
          ? { header: r.header }
          : {}),
        options,
        ...(r.multiSelect === true ? { multiSelect: true } : {}),
      },
    ];
  });
}

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
 *
 * AskUserQuestion gets the same capture-and-deny treatment: there is no interactive human at this
 * seam, so the questions are captured via `onQuestions` and the turn is told to end — they become
 * the turn's report, the owner answers (or escalates to Dennis), and the answers arrive as the
 * session's next message.
 */
const makeCanUseTool =
  (
    readOnly: boolean,
    nativePlan: boolean,
    root: string,
    onPlan: (plan: string) => void,
    onQuestions: (questions: WorkerQuestion[]) => void,
  ): CanUseTool =>
  async (toolName, input): Promise<PermissionResult> => {
    if (toolName === 'AskUserQuestion') {
      if (nativePlan && Array.isArray(input.questions)) {
        onQuestions(normalizeQuestions(input.questions));
        return { behavior: 'deny', message: CLAUDE_DENIALS.questionsRelayed };
      }
      return { behavior: 'deny', message: CLAUDE_DENIALS.noQuestions };
    }
    if (toolName === 'ExitPlanMode') {
      if (typeof input.plan === 'string') onPlan(input.plan);
      return { behavior: 'deny', message: CLAUDE_DENIALS.planRecorded };
    }
    if (readOnly && (toolName === 'Write' || toolName === 'Edit')) {
      return { behavior: 'deny', message: CLAUDE_DENIALS.readOnlyWrite };
    }
    if (toolName === 'Bash') {
      const command = typeof input.command === 'string' ? input.command : '';
      const reason = bashDenyReason(command);
      if (reason)
        return { behavior: 'deny', message: CLAUDE_DENIALS.bashRefused(reason) };
      if (readOnly) {
        const write = bashWriteReason(command);
        if (write)
          return {
            behavior: 'deny',
            message: CLAUDE_DENIALS.readOnlyBash(write),
          };
      }
    }
    if (toolName === 'Write' || toolName === 'Edit') {
      const path = typeof input.file_path === 'string' ? input.file_path : '';
      if (path && !isInsideRoot(path, root)) {
        return { behavior: 'deny', message: CLAUDE_DENIALS.escapesRoot(path) };
      }
    }
    return { behavior: 'allow', updatedInput: input };
  };

/** The Claude Agent SDK engine. The ESM-only SDK arrives via the EsmModule's lazy-loaded DI token. */
@Injectable()
export class ClaudeEngine implements WorkerEngine {
  readonly name = EWorkerEngineName.CLAUDE;

  constructor(
    @Inject(ANTHROPIC_AGENT_SDK)
    private readonly sdk: typeof import('@anthropic-ai/claude-agent-sdk'),
    private readonly env: EnvService,
  ) {}

  async run({
    task,
    cwd,
    systemPrompt,
    agentId,
    sessionId,
    model,
    effort,
    mode,
    apiKey,
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
    // Pin the SDK subprocess to this EMPLOYEE'S isolated config/state home — never the developer's
    // personal ~/.claude, and never shared with other employees (per-employee skills/MCP) — so
    // transcripts land in a stable durable dir and behavior matches deployment.
    const claudeConfigDir = engineHomeDir(
      this.env.get('AGENT_HOME_ROOT'),
      'claude',
      agentId,
    );
    // 'plan' is the native plan posture (permissionMode 'plan' → ExitPlanMode ceremony); both 'plan'
    // and 'investigate' are read-only (no writes), but investigate skips the ceremony for a fast,
    // direct answer.
    const planMode = mode === 'plan';
    const readOnly = mode !== 'execute';
    let capturedPlan = '';
    // Accumulated across the turn, deduped by question text — a model that re-asks despite the
    // deny instruction must not produce duplicate entries in the report.
    const capturedQuestions: WorkerQuestion[] = [];
    const options: Options = {
      cwd,
      systemPrompt,
      // SDK isolation: do NOT inherit the user's global ~/.claude config, skills, or hooks.
      settingSources: [],
      tools: planMode
        ? PLAN_TOOLS
        : readOnly
          ? INVESTIGATE_TOOLS
          : WORKER_TOOLS,
      allowedTools: AUTO_APPROVE,
      canUseTool: makeCanUseTool(
        readOnly,
        planMode,
        cwd,
        (plan) => {
          capturedPlan = plan;
        },
        (questions) => {
          const seen = new Set(capturedQuestions.map((q) => q.question));
          for (const q of questions)
            if (!seen.has(q.question)) capturedQuestions.push(q);
        },
      ),
      permissionMode: planMode ? 'plan' : 'default',
      // Commits are authored via per-worktree git identity — suppress the SDK's default
      // "Co-Authored-By: Claude" commit attribution so it can't muddy that. Inline settings:
      // settingSources stays [] (no config FILES are read).
      settings: { attribution: { commit: '', pr: '' } },
      abortController,
      // Subprocess env: CLAUDE_CONFIG_DIR isolates config/state/transcripts from ~/.claude (always
      // set). The per-tenant key (when resolved) funds this workspace's runs; unset → the key falls
      // back to the ambient env (dev/TUI). settingSources stays [] so NO config files are read.
      env: {
        ...process.env,
        CLAUDE_CONFIG_DIR: claudeConfigDir,
        ...(apiKey ? { ANTHROPIC_API_KEY: apiKey } : {}),
      },
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
    // Captured questions ride alongside; the RUNNER decides precedence (a plan with unanswered
    // questions is a questions-turn, not an approvable plan).
    const planText = (planMode && capturedPlan) || undefined;
    const summary = planText || result || '(no summary)';
    onEvent({ kind: 'result', text: summary });
    return {
      result: summary,
      sessionId: resolvedSession,
      ...(capturedQuestions.length ? { questions: capturedQuestions } : {}),
      ...(planText ? { planText } : {}),
    };
  }
}
