import { Injectable } from '@nestjs/common';
import type { TaskView } from '@workspace/shared';
import { Task, TaskRepo } from '../../_lib/database/entities/task.entity';

/**
 * Task reads — the agent's TODO list across the job's thread groups. Pure mechanism: the controller gates
 * access via `JobService.assertAccess`, and the query is keyed by the denormalized `jobId`.
 */
@Injectable()
export class TaskService {
  constructor(private readonly tasks: TaskRepo) {}

  async listTasks(jobId: string): Promise<TaskView[]> {
    const rows = await this.tasks.find({
      where: { jobId },
      order: { ordinal: 'ASC' },
    });
    return rows.map(toTaskView);
  }
}

function toTaskView(t: Task): TaskView {
  return {
    id: t.id,
    jobId: t.jobId,
    threadGroupId: t.threadGroupId,
    ordinal: t.ordinal,
    title: t.title,
    brief: t.brief,
    activeForm: t.activeForm,
    status: t.status,
    blockedBy: t.blockedBy,
  };
}
