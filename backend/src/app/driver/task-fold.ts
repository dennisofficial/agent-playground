import type { TaskItem } from '../persistence/entities';

const isStr = (v: unknown): v is string => typeof v === 'string';
const asRecord = (v: unknown): Record<string, unknown> =>
  v && typeof v === 'object' ? (v as Record<string, unknown>) : {};

/** Map an SDK task status onto our persisted status. `deleted` is handled before this (the task is
 *  REMOVED from the list — a deleted task is gone, not a struck-through "dropped" row). */
function mapTaskStatus(raw: unknown): TaskItem['status'] | null {
  switch (raw) {
    case 'pending':
    case 'in_progress':
    case 'completed':
      return raw;
    default:
      return null;
  }
}

/**
 * The created task's id, from the TaskCreate tool RESULT. The SDK's task tools return a plain STRING
 * ("Task #8 created successfully: Write tests") — parse the `#<id>` out of it. A structured
 * `{ task: { id } }` result (the shape the web's old transcript fold consumed) is kept as a fallback in
 * case an engine version returns it.
 */
function createdTaskId(result: unknown): string | null {
  if (isStr(result)) {
    // Require the literal `#` so an error string ("Task creation failed") never parses as an id.
    const m = /task\s+#([\w-]+)/i.exec(result);
    return m ? m[1] : null;
  }
  const id = asRecord(asRecord(result).task).id;
  return isStr(id) ? id : null;
}

/**
 * Fold ONE `taskcreate`/`taskupdate` tool call into a task list — the server-side, incremental
 * successor to the web's old batch `foldTasks` (removed with the transcript-fold hack, see
 * `thread-todos.ts`'s prior history). Applied at the shared transcript harness as each event arrives, so
 * the DB carries live state instead of the web replaying the whole transcript. `TaskCreate` registers a
 * task (id parsed from its result — see {@link createdTaskId} — subject from input); `TaskUpdate` (by
 * input `taskId`) applies status/subject changes, and `deleted` REMOVES the task from the list.
 * Unrecognized tool names, or a create whose result carries no recognizable id, are a no-op (best-effort
 * display state, never sinks the calling turn).
 */
export function foldTaskEvent(
  tasks: TaskItem[],
  toolName: string,
  input: Record<string, unknown>,
  result: unknown,
): TaskItem[] {
  const byId = new Map(tasks.map((t) => [t.id, t]));
  const strArr = (v: unknown): string[] => (Array.isArray(v) ? v.filter(isStr) : []);
  // Optional display fields captured when the call carries them (create sets, update overwrites/keeps).
  const extras = (prev?: TaskItem): Pick<TaskItem, 'description' | 'activeForm'> => ({
    ...(isStr(input.description)
      ? { description: input.description }
      : prev?.description
        ? { description: prev.description }
        : {}),
    ...(isStr(input.activeForm)
      ? { activeForm: input.activeForm }
      : prev?.activeForm
        ? { activeForm: prev.activeForm }
        : {}),
  });
  // Dependency edges: prev ∪ addBlockedBy ∖ removeBlockedBy (create can seed `blockedBy` directly).
  const blockedEdges = (prev?: TaskItem): Pick<TaskItem, 'blockedBy'> => {
    const remove = new Set(strArr(input.removeBlockedBy));
    const merged = [
      ...new Set([...(prev?.blockedBy ?? []), ...strArr(input.blockedBy), ...strArr(input.addBlockedBy)]),
    ].filter((b) => !remove.has(b));
    return merged.length > 0 ? { blockedBy: merged } : {};
  };
  // The INVERSE edges — `addBlocks`/`removeBlocks: [x]` means "this task blocks x": fold onto x's
  // blockedBy. Only for ids the fold already knows; an unknown target is a no-op.
  const applyInverseEdges = (id: string): void => {
    for (const target of strArr(input.addBlocks)) {
      const t = byId.get(target);
      if (t) byId.set(target, { ...t, blockedBy: [...new Set([...(t.blockedBy ?? []), id])] });
    }
    for (const target of strArr(input.removeBlocks)) {
      const t = byId.get(target);
      if (!t?.blockedBy) continue;
      const rest = t.blockedBy.filter((b) => b !== id);
      const { blockedBy: _drop, ...bare } = t;
      byId.set(target, rest.length > 0 ? { ...bare, blockedBy: rest } : bare);
    }
  };
  if (toolName === 'taskcreate') {
    const id = createdTaskId(result);
    if (!id) return tasks;
    const subject = isStr(input.subject)
      ? input.subject
      : isStr(input.description)
        ? input.description
        : id;
    byId.set(id, { id, subject, status: 'pending', ...extras(), ...blockedEdges() });
    applyInverseEdges(id);
  } else if (toolName === 'taskupdate') {
    const id = isStr(input.taskId) ? input.taskId : null;
    if (!id) return tasks;
    // Deletion REMOVES the task — Atlas deleting a task means it's gone from the checklist, not kept as
    // a struck-through row. An unknown id is a no-op (nothing to remove, no defensive entry).
    if (input.status === 'deleted') {
      byId.delete(id);
      return [...byId.values()];
    }
    const existing = byId.get(id);
    const status = mapTaskStatus(input.status) ?? existing?.status ?? 'pending';
    const subject = isStr(input.subject) ? input.subject : (existing?.subject ?? id);
    byId.set(id, { id, subject, status, ...extras(existing), ...blockedEdges(existing) });
    applyInverseEdges(id);
  } else {
    return tasks; // TaskList / TaskGet are reads — no mutation
  }
  return [...byId.values()];
}

/** The task-tool names (lowercased) the harness special-cases; TaskList/TaskGet are reads, excluded. */
export const MUTATING_TASK_TOOL_NAMES = new Set(['taskcreate', 'taskupdate']);
