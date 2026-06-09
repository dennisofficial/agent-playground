import {
  type CanUseTool,
  type Options,
  type PermissionResult,
  query,
} from '@anthropic-ai/claude-agent-sdk';
import { bashDenyReason, bashWriteReason, isInsideRoot } from './guard.js';
import type { RunWorkerArgs, WorkerEngine } from './types.js';

// The base set of built-in tools the worker may use. `tools` RESTRICTS the available set — unlike
// `allowedTools`, which only auto-approves. No WebSearch/Agent/MCP: a focused file+shell worker.
const WORKER_TOOLS = ['Read', 'Glob', 'Grep', 'Write', 'Edit', 'Bash'];
// Auto-approve safe reads. Write/Edit/Bash are intentionally absent so they fall through to
// canUseTool, where the repo's project-root + bash boundary is re-applied.
const AUTO_APPROVE = ['Read', 'Glob', 'Grep'];

/**
 * Re-applies the repo's existing safety boundary to the SDK's built-in tools: file writes must stay
 * inside the project root, and bash commands must clear the deny-list. With `permissionMode:
 * 'default'`, every non-auto-approved tool call routes here — this is a programmatic gate (there is
 * no interactive surface), so it never blocks waiting on a human.
 *
 * When `planning` is set, the gate is also READ-ONLY: Write/Edit are denied outright and mutating
 * shell is refused, so a PLAN pass physically cannot touch the project (the core "plan first, build
 * only once approved" guarantee). Built per-run because the planning flag varies by job.
 */
const makeCanUseTool =
  (planning: boolean): CanUseTool =>
  async (toolName, input): Promise<PermissionResult> => {
    if (planning && (toolName === 'Write' || toolName === 'Edit')) {
      return {
        behavior: 'deny',
        message: 'Planning is read-only — describe the change in your plan instead of writing it.',
      };
    }
    if (toolName === 'Bash') {
      const command = typeof input.command === 'string' ? input.command : '';
      const reason = bashDenyReason(command);
      if (reason) return { behavior: 'deny', message: `Refused: ${reason}.` };
      if (planning) {
        const write = bashWriteReason(command);
        if (write) return { behavior: 'deny', message: `Planning is read-only — ${write}.` };
      }
    }
    if (toolName === 'Write' || toolName === 'Edit') {
      const path = typeof input.file_path === 'string' ? input.file_path : '';
      if (path && !isInsideRoot(path)) {
        return { behavior: 'deny', message: `Refused: "${path}" escapes the project directory.` };
      }
    }
    return { behavior: 'allow', updatedInput: input };
  };

export const claudeEngine: WorkerEngine = {
  name: 'claude',
  async run({
    task,
    cwd,
    systemPrompt,
    sessionId,
    model,
    effort,
    planning,
    onEvent,
    signal,
  }: RunWorkerArgs) {
    // The SDK cancels via its own AbortController (it kills the child process); bridge our run signal to it.
    const abortController = new AbortController();
    if (signal) {
      if (signal.aborted) abortController.abort();
      else signal.addEventListener('abort', () => abortController.abort(), { once: true });
    }
    const resolvedModel = model ?? process.env.WORKER_MODEL;
    const options: Options = {
      cwd,
      systemPrompt,
      // SDK isolation: do NOT inherit the user's global ~/.claude config, skills, or hooks.
      settingSources: [],
      tools: WORKER_TOOLS,
      allowedTools: AUTO_APPROVE,
      canUseTool: makeCanUseTool(planning ?? false),
      permissionMode: 'default',
      abortController,
      ...(sessionId ? { resume: sessionId } : {}),
      ...(resolvedModel ? { model: resolvedModel } : {}),
      ...(effort ? { effort } : {}),
    };

    let result = '';
    let resolvedSession = sessionId;
    for await (const message of query({ prompt: task, options })) {
      if (message.type === 'system' && message.subtype === 'init') {
        resolvedSession = message.session_id;
      } else if (message.type === 'assistant') {
        for (const block of message.message.content as Array<{
          type: string;
          text?: string;
          name?: string;
        }>) {
          if (block.type === 'text' && block.text) onEvent({ kind: 'text', text: block.text });
          else if (block.type === 'tool_use' && block.name)
            onEvent({ kind: 'tool', name: block.name });
        }
      } else if (message.type === 'result') {
        resolvedSession = message.session_id;
        if (message.subtype === 'success') result = message.result;
        else throw new Error(`Claude worker ended: ${message.subtype}`);
      }
    }

    const summary = result || '(no summary)';
    onEvent({ kind: 'result', text: summary });
    return { result: summary, sessionId: resolvedSession };
  },
};
