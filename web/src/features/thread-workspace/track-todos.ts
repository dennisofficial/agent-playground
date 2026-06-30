import type { ThreadMessage } from '@/lib/api/thread-api';
import type { LiveBlock } from '@/lib/api/thread-stream';

/**
 * The orchestrator's LIVE TASK LIST — the per-track checklist the navigator shows in place of the
 * (dropped) pre-planned `plan` axis. The build orchestrator maintains it via the SDK task tools
 * (`TaskCreate` / `TaskUpdate`, the 0.3.x successors to `TodoWrite`); this module reconstructs the current
 * list by FOLDING those tool calls — a latest-snapshot would lose dropped items, but folding keeps a
 * `status:'deleted'` task visible as a struck-through "dropped" row (per the design).
 *
 * The join is the same one `track-subagents.ts` uses: the turn harness stamps every execute-turn block with
 * `meta.phaseId` (the batch anchor step id), so a task call "belongs to" the track-session whose phaseId
 * tags it. Calls carrying `meta.parentToolUseId` are a writer subagent's, not the orchestrator's, and are
 * excluded — only the session's own task list shows.
 *
 * @see {@link durableSubagentRunsByPhase} — the sibling derivation for the writer-run (`agents`) axis.
 */

/** One task in the orchestrator's live list. `dropped` = the agent abandoned it (SDK `status:'deleted'`). */
export interface TaskItem {
  id: string;
  subject: string;
  status: 'pending' | 'in_progress' | 'completed' | 'dropped';
  /** The most-recently-created still-pending task — rendered with a `new` badge. */
  isNew?: boolean;
}

const isStr = (v: unknown): v is string => typeof v === 'string';
const asRecord = (v: unknown): Record<string, unknown> =>
  v && typeof v === 'object' ? (v as Record<string, unknown>) : {};

/** Map an SDK task status onto our display status (`deleted` → `dropped`). */
function mapStatus(raw: unknown): TaskItem['status'] | null {
  switch (raw) {
    case 'pending':
    case 'in_progress':
    case 'completed':
      return raw;
    case 'deleted':
      return 'dropped';
    default:
      return null;
  }
}

/** A normalized task-tool call — just the fields the fold needs, from a durable or live block. */
interface TaskCall {
  name: string; // lowercased tool name
  input: Record<string, unknown>;
  result: Record<string, unknown>;
}

/**
 * Fold an ordered list of task-tool calls into the current task list. `TaskCreate` registers a task (id
 * from its result `{task:{id}}`, subject from input); `TaskUpdate` (by input `taskId`) applies status /
 * subject changes, including `deleted` → dropped. Insertion order is preserved.
 */
function foldTasks(calls: TaskCall[]): TaskItem[] {
  const byId = new Map<string, TaskItem>();
  let lastCreatedId: string | null = null;

  calls.forEach((c, i) => {
    if (c.name === 'taskcreate') {
      const id = isStr(asRecord(c.result.task).id)
        ? (asRecord(c.result.task).id as string)
        : `pending:${i}`; // live create before its result lands — keep a stable per-index key so it shows
      const subject = isStr(c.input.subject) ? c.input.subject : isStr(c.input.description) ? c.input.description : id;
      byId.set(id, { id, subject, status: 'pending' });
      lastCreatedId = id;
    } else if (c.name === 'taskupdate') {
      const id = isStr(c.input.taskId) ? c.input.taskId : null;
      if (!id) return;
      const existing = byId.get(id);
      const status = mapStatus(c.input.status) ?? existing?.status ?? 'pending';
      const subject = isStr(c.input.subject) ? c.input.subject : (existing?.subject ?? id);
      byId.set(id, { id, subject, status });
    }
    // TaskList / TaskGet are reads — they don't mutate the list.
  });

  if (lastCreatedId) {
    const last = byId.get(lastCreatedId);
    if (last && last.status === 'pending') last.isNew = true;
  }
  return [...byId.values()];
}

const TASK_TOOL_NAMES = new Set(['taskcreate', 'taskupdate', 'tasklist', 'taskget']);

/**
 * Durable: anchorStepId → the orchestrator session's task list, folded from its task-tool calls (joined by
 * `meta.phaseId`). Excludes calls tagged to a writer subagent (`meta.parentToolUseId`).
 */
export function durableTaskListByPhase(messages: ThreadMessage[]): Map<string, TaskItem[]> {
  const callsByPhase = new Map<string, TaskCall[]>();
  for (const m of messages) {
    if (m.kind !== 'tool') continue;
    const meta = m.meta ?? {};
    if (isStr(meta.parentToolUseId)) continue; // a writer subagent's task call, not the session's
    const phaseId = isStr(meta.phaseId) ? meta.phaseId : null;
    if (!phaseId) continue;
    const name = isStr(meta.name) ? meta.name.toLowerCase() : '';
    if (!TASK_TOOL_NAMES.has(name)) continue;
    const arr = callsByPhase.get(phaseId) ?? [];
    arr.push({ name, input: asRecord(meta.input), result: asRecord(meta.result) });
    callsByPhase.set(phaseId, arr);
  }
  const out = new Map<string, TaskItem[]>();
  for (const [phaseId, calls] of callsByPhase) out.set(phaseId, foldTasks(calls));
  return out;
}

/**
 * Live: the orchestrator session's task list on ONE phase lane (`phase:<anchorStepId>`), folded from the
 * lane's task-tool calls. The lane is already phase-scoped; subagent calls carry `parentToolUseId` and are
 * excluded so only the session's own list shows.
 */
export function liveTaskListForPhase(laneBlocks: LiveBlock[]): TaskItem[] {
  const calls: TaskCall[] = [];
  for (const b of laneBlocks) {
    if (b.kind !== 'tool') continue;
    if (b.parentToolUseId) continue;
    const name = b.name.toLowerCase();
    if (!TASK_TOOL_NAMES.has(name)) continue;
    calls.push({ name, input: asRecord(b.input), result: asRecord(b.result) });
  }
  return foldTasks(calls);
}
