import type { ToolImpl } from '../../_shared/engine/engine.types';
import type { TaskItem } from '../persistence/entities';
import type { TaskScope } from './thread-registry';
import type { TaskEventSink } from './turn-harness.service';

export function makeTaskTools(sink: TaskEventSink, scope: TaskScope): Record<string, ToolImpl> {
  return {
    task_create: async (args) => {
      const subject = String(args['subject'] ?? '').trim();
      if (!subject)
        return {
          ok: false,
          error: 'subject is required (a one-line task title)',
        };
      const { id } = await sink.createTask(scope, args);
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

export function renderTaskList(tasks: TaskItem[]): string {
  if (tasks.length === 0) return 'No tasks found.';
  return tasks
    .map((t) => {
      const blocked = t.blockedBy?.length ? ` (blocked by ${t.blockedBy.join(', ')})` : '';
      return `#${t.id} [${t.status}] ${t.subject}${blocked}`;
    })
    .join('\n');
}

export function renderTaskDetail(t: TaskItem): string {
  const lines = [`#${t.id} [${t.status}] ${t.subject}`];
  if (t.description) lines.push(`  description: ${t.description}`);
  if (t.activeForm) lines.push(`  activeForm: ${t.activeForm}`);
  if (t.blockedBy?.length) lines.push(`  blocked by: ${t.blockedBy.join(', ')}`);
  return lines.join('\n');
}
