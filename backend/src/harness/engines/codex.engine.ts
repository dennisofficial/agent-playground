import { EnvService } from '@core/config/env/env.service';
import { Inject, Injectable } from '@nestjs/common';
import { execFileSync } from 'node:child_process';
import type { Codex, ThreadOptions } from '@openai/codex-sdk';
import { OPENAI_CODEX_SDK } from '../../_lib/esm/esm.module';
import type { RunWorkerArgs, WorkerEngine } from './worker-engine.port';

/**
 * The repo's SHARED git dir for `cwd`. When the working directory is a subdir (or a linked
 * worktree), `.git` lives OUTSIDE it — codex's workspace-write sandbox must be granted it
 * explicitly or commit/push/merge fail. Best-effort: undefined when `cwd` isn't in a git repo.
 */
function gitCommonDir(cwd: string): string | undefined {
  try {
    return (
      execFileSync('git', ['rev-parse', '--path-format=absolute', '--git-common-dir'], {
        cwd,
        encoding: 'utf8',
      }).trim() || undefined
    );
  } catch {
    return undefined;
  }
}

/** The OpenAI Codex SDK engine (drives the local `codex` CLI as a subprocess). ESM-only — arrives
 * via the EsmModule's lazy-loaded DI token; the client itself is constructed lazily. */
@Injectable()
export class CodexEngine implements WorkerEngine {
  readonly name = 'codex' as const;
  private client?: Codex;

  constructor(
    @Inject(OPENAI_CODEX_SDK) private readonly sdk: typeof import('@openai/codex-sdk'),
    private readonly env: EnvService,
  ) {}

  private getCodex(): Codex {
    return (this.client ??= new this.sdk.Codex());
  }

  private threadOptions(cwd: string, opts: { model?: string; planning?: boolean } = {}): ThreadOptions {
    const model = opts.model ?? this.env.get('CODEX_MODEL');
    // Grant write access to the shared git dir (it's outside cwd) so an EXECUTE worker can commit /
    // push / merge. Not needed in the read-only PLAN pass.
    const gitDir = opts.planning ? undefined : gitCommonDir(cwd);
    return {
      workingDirectory: cwd,
      // Confine writes/shell to the project; run autonomously (no interactive approval surface).
      // A PLAN pass is read-only so it physically cannot mutate the project before approval.
      sandboxMode: opts.planning ? 'read-only' : 'workspace-write',
      approvalPolicy: 'never',
      skipGitRepoCheck: true,
      // Live web search is the whole point of using Codex for research, and a model-side tool
      // separate from the shell sandbox — safe to leave on even in the read-only PLAN pass.
      webSearchMode: 'live',
      ...(gitDir ? { additionalDirectories: [gitDir] } : {}),
      ...(model ? { model } : {}),
    };
  }

  async run({ task, cwd, systemPrompt, sessionId, model, planning, onEvent, signal }: RunWorkerArgs) {
    const client = this.getCodex();
    const opts = this.threadOptions(cwd, { model, planning });
    const thread = sessionId ? client.resumeThread(sessionId, opts) : client.startThread(opts);

    // Codex has no systemPrompt option, so seed our worker persona as a preamble on the first turn.
    const input = sessionId ? task : `${systemPrompt}\n\n---\n\nTask: ${task}`;

    let result = '';
    let resolvedSession = sessionId;
    const { events } = await thread.runStreamed(input, { signal });
    for await (const event of events) {
      switch (event.type) {
        case 'thread.started':
          resolvedSession = event.thread_id;
          break;
        case 'item.completed': {
          const item = event.item;
          switch (item.type) {
            case 'agent_message':
              onEvent({ kind: 'text', text: item.text });
              result = item.text;
              break;
            case 'reasoning':
              onEvent({ kind: 'text', text: item.text });
              break;
            case 'command_execution':
              onEvent({ kind: 'tool', name: 'bash', detail: item.command });
              break;
            case 'file_change':
              onEvent({
                kind: 'tool',
                name: 'edit',
                detail: item.changes.map((c) => `${c.kind} ${c.path}`).join(', '),
              });
              break;
            case 'mcp_tool_call':
              onEvent({ kind: 'tool', name: `${item.server}/${item.tool}` });
              break;
            case 'web_search':
              onEvent({ kind: 'tool', name: 'web_search', detail: item.query });
              break;
            case 'error':
              onEvent({ kind: 'text', text: `error: ${item.message}` });
              break;
          }
          break;
        }
        case 'turn.failed':
          throw new Error(event.error.message);
        case 'error':
          throw new Error(event.message);
      }
    }

    const summary = result || '(no summary)';
    onEvent({ kind: 'result', text: summary });
    return { result: summary, sessionId: resolvedSession ?? thread.id ?? undefined };
  }
}
