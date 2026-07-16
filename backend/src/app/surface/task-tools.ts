import type { ToolImpl } from '../engine/engine.types';
import type { TaskEventSink } from './turn-harness.service';
import type { TaskScope } from './thread-registry';
import type { TaskItem } from '../persistence/entities';

/**
 * The shared `task_create`/`task_update`/`task_list`/`task_get` host-bridge handlers — one factory used
 * IDENTICALLY by Claude and Codex sessions (registered into the bridge `tools` map, which auto-exposes
 * them to both engines). They do direct CRUD on the stage-owned `tasks` rows via {@link TaskEventSink}.
 *
 * SINGLE DURABLE ID SPACE: the id `task_create` returns is the row's short per-stage `#N` (its dense
 * `ordinal`, 1/2/3…), and the ids `task_list`/`task_get` report are those SAME `#N` — so an id from any of
 * them is always a valid `task_update` key. The `TaskEntity` uuid PK stays the internal row identity; reads
 * hit the durable rows fresh, so a builder-leg rotation (a new session) never loses the carried checklist.
 */
export function makeTaskTools(
  sink: TaskEventSink,
  scope: TaskScope,
): Record<string, ToolImpl> {
  return {
    task_create: async (args) => {
      const subject = String(args['subject'] ?? '').trim();
      if (!subject)
        return {
          ok: false,
          error: 'subject is required (a one-line task title)',
        };
      const { id } = await sink.createTask(scope, args);
      // Keep this exact wording — the web live overlay's `createdTaskId` regex parses the `#N` out of it.
      return `Task #${id} created: ${subject}`;
    },
    task_update: async (args) => {
      const taskId = String(args['taskId'] ?? '').trim();
      if (!taskId)
        return {
          ok: false,
          error: 'taskId is required (the id from task_create/task_list)',
        };
      return sink.updateTask(scope, args);
    },
    task_list: async () => renderTaskList(await sink.readTasks(scope)),
    task_get: async (args) => {
      const id = String(args['taskId'] ?? '').trim();
      if (!id) return { ok: false, error: 'taskId is required' };
      const task = (await sink.readTasks(scope)).find((t) => t.id === id);
      return task ? renderTaskDetail(task) : `No task ${id} found`;
    },
  };
}

/** One task per line: `#<id> [<status>] <subject>` (+ ` (blocked by …)`); empty → `"No tasks found."`. */
export function renderTaskList(tasks: TaskItem[]): string {
  if (tasks.length === 0) return 'No tasks found.';
  return tasks
    .map((t) => {
      const blocked = t.blockedBy?.length
        ? ` (blocked by ${t.blockedBy.join(', ')})`
        : '';
      return `#${t.id} [${t.status}] ${t.subject}${blocked}`;
    })
    .join('\n');
}

/** A short multi-line detail block for one task — only the fields that are present are shown. */
export function renderTaskDetail(t: TaskItem): string {
  const lines = [`#${t.id} [${t.status}] ${t.subject}`];
  if (t.description) lines.push(`  description: ${t.description}`);
  if (t.activeForm) lines.push(`  activeForm: ${t.activeForm}`);
  if (t.blockedBy?.length)
    lines.push(`  blocked by: ${t.blockedBy.join(', ')}`);
  return lines.join('\n');
}
