import { Codex, type ThreadOptions } from '@openai/codex-sdk';
import type { RunWorkerArgs, WorkerEngine } from './types.js';

// One Codex client, lazily constructed (it drives the local `codex` CLI as a subprocess).
let codex: Codex | undefined;
const getCodex = () => (codex ??= new Codex());

function threadOptions(cwd: string): ThreadOptions {
  return {
    workingDirectory: cwd,
    // Confine writes/shell to the project; run autonomously (no interactive approval surface).
    sandboxMode: 'workspace-write',
    approvalPolicy: 'never',
    skipGitRepoCheck: true,
    ...(process.env.CODEX_MODEL ? { model: process.env.CODEX_MODEL } : {}),
  };
}

export const codexEngine: WorkerEngine = {
  name: 'codex',
  async run({ task, cwd, systemPrompt, sessionId, onEvent }: RunWorkerArgs) {
    const client = getCodex();
    const thread = sessionId
      ? client.resumeThread(sessionId, threadOptions(cwd))
      : client.startThread(threadOptions(cwd));

    // Codex has no systemPrompt option, so seed our worker persona as a preamble on the first turn.
    const input = sessionId ? task : `${systemPrompt}\n\n---\n\nTask: ${task}`;

    let result = '';
    let resolvedSession = sessionId;
    const { events } = await thread.runStreamed(input);
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
  },
};
