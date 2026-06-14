import type { ChatTracePointer } from '@workspace/langfuse';
import type { z } from 'zod';
import type { Identity } from '../domain/identity';

/** Per-call context threaded from the run config (set by the conductor) into a tool's execute. */
export interface HarnessToolContext {
  identity: Identity;
  /**
   * Best-effort pointer to the chat turn's Langfuse trace, captured at the tool seam. Threaded into
   * detached background work (session turns) purely to LINK it back to the turn that spawned it —
   * `undefined` when no span is active. Never load-bearing.
   */
  parentChatTrace?: ChatTracePointer;
}

/**
 * Which part of the pre-LLM context a tool call can dirty. Used by the graph to decide which
 * context slices to recompute after a tool batch (same discovery pattern as `terminal`).
 * - 'work'   → worktrees + open sessions (create_worktree, remove_worktree, close_session)
 * - 'memory' → semantic facts (remember, update_memory, forget)
 * - 'tasks'  → reminders plate (add_task, complete_task)
 */
export type RefreshScope = 'work' | 'memory' | 'tasks';

/**
 * A chat-layer tool, as a Nest injectable. Decorate implementations with `@HarnessTool()` and
 * register them in `ToolsModule`; the `ToolRegistry` discovers them and binds them to the LLM as
 * LangChain StructuredTools at graph-build time. Employees allowlist tools by CLASS REFERENCE
 * (`tools: [DispatchJobTool, RecallTool]`), never by name string.
 */
export interface IHarnessTool<S extends z.ZodTypeAny = z.ZodTypeAny> {
  /** The LLM-visible tool name (e.g. 'dispatch_job'). */
  readonly name: string;
  readonly description: string;
  readonly schema: S;
  /**
   * True → a call to this tool ENDS the bot's turn (the graph's terminal set is derived from this
   * flag, not from a magic-string list in the graph).
   */
  readonly terminal?: boolean;
  /**
   * Parts of the pre-LLM context a successful call dirties — the graph recomputes ONLY these after
   * the tool runs (same discovery pattern as `terminal`). Omit for read-only tools.
   */
  readonly refreshesContext?: readonly RefreshScope[];
  execute(args: z.infer<S>, ctx: HarnessToolContext): Promise<string>;
}
