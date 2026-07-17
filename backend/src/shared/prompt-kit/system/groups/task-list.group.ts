/**
 * prompt-kit / groups / task-list — the live task-list discipline. Both variants reuse the shared
 * `TASK_LIST_NOTE` catalog block and add their own seeding rule (what the first tasks come from).
 *
 * TOPIC bucket: the live task list.
 */
import { Agent, ENGINEERING_STAGES } from '../agent';
import { isOnboarding, notOnboarding } from '../conditions';
import { Fragment, FragmentGroup } from '../fragment.decorator';
import { TASK_LIST_NOTE } from '../fragments';

@FragmentGroup()
export class TaskListGroup {
  /** Task list + Main-row seeding rule. */
  @Fragment({
    usedBy: ENGINEERING_STAGES,
    order: 1270,
    condition: notOnboarding,
  })
  taskListNormal(): string {
    return [
      TASK_LIST_NOTE,
      "Here the list is the Main row's checklist. Use it whenever a turn does real multi-step WORK — implementing",
      'an approved direct build, a multi-step investigation, working an event, fixing an environment gap — so the',
      'operator watches structured progress instead of an opaque stream. A pure conversation turn (answering a',
      'question, grilling) needs no task list.',
    ].join('\n');
  }

  /** Task list + fleet-inventory seeding rule. */
  @Fragment({
    usedBy: [Agent.PLANNING],
    order: 2030,
    condition: isOnboarding,
  })
  taskListOnboarding(): string {
    return [
      TASK_LIST_NOTE,
      'Here the list IS the ceremony made visible: once the operator green-lights the bring-up (see the',
      'GROUNDING GATE) and step 1 firms up the fleet inventory, seed the list from it and let the operator',
      'watch each service go pending → in_progress → completed as it boots and validates. Do NOT stand up the',
      'task list during the read-only grounding pass — that pass ends by presenting the inventory and stopping.',
      'If discovery reshapes the fleet (a service turns out to be two, one is not locally runnable), reshape',
      'the list to match.',
    ].join('\n');
  }
}
