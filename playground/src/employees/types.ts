import type { StructuredToolInterface } from '@langchain/core/tools';
import type { EffortLevel, WorkerEngineName } from '../engines/types.js';

/**
 * An employee — one self-contained AI teammate. Everything that makes a teammate distinct lives in one
 * `Employee` value: its identity, the deep role knowledge that seeds its system prompt, the engine its
 * background work runs on, and (optionally) the chat tools it carries. Adding a teammate is a new file
 * in this folder plus one line in `index.ts` — nothing in persona.ts, bot-graph.ts, or chat.ts.
 *
 * This is the plug-in unit; `bot` throughout the codebase is just an instance of one.
 */
export interface Employee {
  /** Stable handle, lowercase (e.g. "alex"). Used for @mentions, scoping, and thread ids. */
  id: string;
  /** Display name (e.g. "Alex"). */
  name: string;
  /** Short role label (e.g. "backend engineer") — shown in the roster summary. */
  role: string;
  /**
   * Scrum-master clearance: board-wide authority. A scrum master sees EVERY teammate's reminders and
   * tickets (others see only their own), and can pause + escalate a teammate's out-of-scope work. Exactly
   * one employee should carry this (Sam). Read programmatically (not from the `role` string) wherever
   * authority is gated — see memory/tools.ts, board/tools.ts.
   */
  scrumMaster?: boolean;
  /**
   * The deep role knowledge folded into this employee's chat system prompt (what `persona.ts` used to
   * carry in per-id if-branches). MUST be a static, byte-stable string: `chatPromptFor` runs on every
   * LLM step under a `cache_control: ephemeral` breakpoint, so any per-call variation here silently
   * busts the prompt cache. No file reads, no volatile interpolation.
   */
  roleContext: string;
  /**
   * The engine this employee's dispatched background work runs on. An employee is LOCKED to its engine
   * — there is no per-dispatch override; switch engines by changing this field.
   */
  engine: WorkerEngineName;
  /**
   * Per-phase model tiering (optional overrides; per-engine defaults in `resolveWorkerModel` apply when
   * unset). The PLAN pass runs on a high-reasoning model + effort so the worker thinks hard about WHAT
   * to build; the EXECUTE pass runs on a cheaper model to build the already-approved plan. Only set
   * these to deviate from the engine defaults (e.g. a different model for one teammate).
   */
  planModel?: string;
  planEffort?: EffortLevel;
  execModel?: string;
  /**
   * Optional override for the employee's chat-side tools; defaults to the shared `CHAT_TOOLS` (resolved
   * at the consumer in bot-graph.ts, so unset employees never import chat.ts).
   *
   * Cycle guard: if you override this, pass an INDEPENDENT tool array. Importing the shared tools from
   * `chat.ts` here would form `employees → chat → employees` (chat.ts imports this registry for engine
   * lookup). To share tools, first lift them into a cycle-free `tools/` module. Note also that the chat
   * prompt DESCRIBES the toolset in prose, so an override that changes tools needs that prose updated.
   */
  chatTools?: StructuredToolInterface[];
}
