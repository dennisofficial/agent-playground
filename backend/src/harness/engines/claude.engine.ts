import type {
  CanUseTool,
  McpServerConfig as SdkMcpServerConfig,
  Options,
  PermissionResult,
} from '@anthropic-ai/claude-agent-sdk';
import { EnvService } from '@core/config/env/env.service';
import { engineHomeDir } from './engine-home';
import { Inject, Injectable } from '@nestjs/common';
import { ANTHROPIC_AGENT_SDK } from '../../_lib/esm/esm.module';
import { AGENT_TOOLS_PROVIDER } from './agent-tools-provider.port';
import type { IAgentToolsProvider } from './agent-tools-provider.port';
import type { McpServerConfig } from '../skills/skill.types';
import {
  bashDenyReason,
  bashWriteReason,
  isInsideRoot,
  relaxedSandboxGuard,
} from './guard';
import { spawnInOwnGroup } from './process-group';
import { CLAUDE_DENIALS } from './engine.prompts';
import {
  EWorkerEngineName,
  IWorkerUsage,
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
 * workspace, and bash commands must clear the deny-list. Every non-auto-approved tool call routes
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
        return {
          behavior: 'deny',
          message: CLAUDE_DENIALS.bashRefused(reason),
        };
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

/** Map our engine-neutral MCP config to the SDK's keyed `mcpServers` Record. stdio → process
 * transport, http → http transport (the two kinds our `McpServerConfig` union models). */
function toSdkMcpServers(
  servers: ReadonlyArray<McpServerConfig>,
): Record<string, SdkMcpServerConfig> {
  const out: Record<string, SdkMcpServerConfig> = {};
  for (const s of servers) {
    out[s.name] =
      s.transport === 'stdio'
        ? {
            type: 'stdio',
            command: s.command,
            ...(s.args ? { args: s.args } : {}),
            ...(s.env ? { env: s.env } : {}),
          }
        : {
            type: 'http',
            url: s.url,
            ...(s.headers ? { headers: s.headers } : {}),
          };
  }
  return out;
}

/** The Claude Agent SDK engine. The ESM-only SDK arrives via the EsmModule's lazy-loaded DI token. */
@Injectable()
export class ClaudeEngine implements WorkerEngine {
  readonly name = EWorkerEngineName.CLAUDE;

  constructor(
    @Inject(ANTHROPIC_AGENT_SDK)
    private readonly sdk: typeof import('@anthropic-ai/claude-agent-sdk'),
    private readonly env: EnvService,
    @Inject(AGENT_TOOLS_PROVIDER)
    private readonly provisioner: IAgentToolsProvider,
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
    // This employee's resolved skills + MCP servers (the boot/reconcile provisioner already
    // materialized the per-employee claude home — skills are symlinked into <CLAUDE_CONFIG_DIR>/skills,
    // MCP rides in-memory here). Empty for un-provisioned employees → options stay exactly as before.
    const agentTools = this.provisioner.forAgent(agentId);
    const mcpServers = toSdkMcpServers(agentTools.mcpServers);
    let capturedPlan = '';
    // Accumulated across the turn, deduped by question text — a model that re-asks despite the
    // deny instruction must not produce duplicate entries in the report.
    const capturedQuestions: WorkerQuestion[] = [];
    const options: Options = {
      cwd,
      systemPrompt,
      // Skill DISCOVERY is gated by the setting sources — the `skills` option only FILTERS what's
      // discovered, so with `[]` nothing is found and the symlinked skills never load (proven by
      // claude-skill-discovery.ai.test.ts). `'user'` makes the CLI scan the user config dir's
      // `skills/`, which — because CLAUDE_CONFIG_DIR is overridden to this employee's ISOLATED home
      // (below) — is OUR per-employee skills dir, NOT the developer's ~/.claude. So isolation is held
      // by CLAUDE_CONFIG_DIR, and we only widen to `'user'` when this employee actually has skills.
      settingSources: agentTools.skillNames.length ? ['user'] : [],
      // `tools` RESTRICTS the available built-in set — so the `Skill` tool must be listed here when
      // this employee has skills, or the model can't invoke them even though they're discovered.
      tools: (() => {
        const base = planMode
          ? PLAN_TOOLS
          : readOnly
            ? INVESTIGATE_TOOLS
            : WORKER_TOOLS;
        return agentTools.skillNames.length ? [...base, 'Skill'] : base;
      })(),
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
      // Commits are authored via per-workspace git identity — suppress the SDK's default
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
      // In-sandbox self-validation hardening (Phase 10): spawn the CLI subprocess as its own process-
      // group leader so backgrounded dev servers (`pnpm dev &`, `next dev`) it starts are reaped with
      // it on abort/shutdown. ONLY in the relaxed-sandbox (daemon) posture — on the HOST the flag is
      // never set, the hook is omitted, and the SDK's own spawn runs exactly as before (byte-identical).
      ...(relaxedSandboxGuard()
        ? { spawnClaudeCodeProcess: spawnInOwnGroup }
        : {}),
      ...(sessionId ? { resume: sessionId } : {}),
      ...(resolvedModel ? { model: resolvedModel } : {}),
      ...(effort ? { effort } : {}),
      // Enable ONLY this employee's skills — the SDK's `skills` option is the single switch that turns
      // the Skill tool on; `tools` above restricts only BUILT-IN tools, so it doesn't gate these.
      // Omitted when empty so un-provisioned employees keep the prior (no-skills) posture.
      ...(agentTools.skillNames.length ? { skills: agentTools.skillNames } : {}),
      // Pass this employee's MCP servers in-memory; `strictMcpConfig` so ONLY these load (settingSources
      // is [] already, but this also blocks any stray on-disk .mcp.json from leaking in).
      ...(Object.keys(mcpServers).length
        ? { mcpServers, strictMcpConfig: true }
        : {}),
    };

    let result = '';
    let resolvedSession = sessionId;
    let workerUsage: IWorkerUsage | undefined;
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
        if (message.subtype === 'success') {
          result = message.result;
          // Extract token usage from the SDK result. Convention: inputTokens = grand total
          // INCLUDING cache (fresh + cacheRead + cacheWrite); the SDK's `input_tokens` field
          // excludes cache, so we add the cache slices back in.
          const u = (message as Record<string, unknown>).usage as
            | {
                input_tokens?: number;
                output_tokens?: number;
                cache_read_input_tokens?: number;
                cache_creation_input_tokens?: number;
              }
            | undefined;
          const costUsd = (message as Record<string, unknown>)
            .total_cost_usd as number | undefined;
          const modelUsage = (message as Record<string, unknown>).modelUsage as
            | Record<string, unknown>
            | undefined;
          if (u) {
            const cacheRead = u.cache_read_input_tokens ?? 0;
            const cacheWrite = u.cache_creation_input_tokens ?? 0;
            const freshInput = u.input_tokens ?? 0;
            const inputTokens = freshInput + cacheRead + cacheWrite;
            const outputTokens = u.output_tokens;
            // Use the modelUsage key as the real model id (the SDK records the actual id there,
            // which differs from `resolvedModel` when the caller passed an alias or undefined).
            const usedModel =
              (modelUsage ? Object.keys(modelUsage)[0] : undefined) ??
              resolvedModel;
            workerUsage = {
              inputTokens,
              ...(outputTokens !== undefined ? { outputTokens } : {}),
              ...(cacheRead > 0 ? { cacheReadTokens: cacheRead } : {}),
              ...(cacheWrite > 0 ? { cacheWriteTokens: cacheWrite } : {}),
              ...(costUsd !== undefined ? { costUsd } : {}),
              ...(usedModel ? { model: usedModel } : {}),
            };
          }
        } else throw new Error(`Claude worker ended: ${message.subtype}`);
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
      ...(workerUsage ? { usage: workerUsage } : {}),
    };
  }
}
