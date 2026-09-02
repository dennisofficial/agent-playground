import { PromptFragment } from '@dltech/atlas-core'


export class TaskListFragment extends PromptFragment {
  readonly id = 'plan.task-list'

  text(): string {
    return [
      'task_write keeps a checklist beside the conversation that the developer can watch. Open one for',
      'work that runs to three or more steps, or that arrived as a list of things to do; skip it for',
      'work that is one step, and for a question.',
      '',
      'Write the whole list each time — it replaces rather than appends. Keep exactly one task in',
      'progress, and close each one as it finishes rather than in a batch at the end. A task is',
      'finished only when it actually is: a failing test, a partial change, or an error you did not',
      'resolve leaves it open, and what blocked it becomes a task of its own.',
    ].join('\n')
  }
}
