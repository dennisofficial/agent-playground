import {
  AfterToolHook,
  EStage,
  enteredWorktreeOf,
  exitedWorktreeOf,
  type AfterTool,
  type EventDraft,
  type HookOrder,
} from '@dltech/atlas-core'

import { injectable } from '../container/injection'

@injectable()
export class TrackWorktreeHook extends AfterToolHook {
  readonly name = 'track-worktree'
  readonly order: HookOrder = { stage: EStage.Observe, nudge: 0 }

  readonly run: AfterTool = async ({ result }) => {
    if (!result.ok) return {}

    const entered = enteredWorktreeOf(result.output)
    if (entered !== undefined) {
      const draft: EventDraft = { type: 'worktree-entered', ...entered }
      return { drafts: [draft] }
    }

    const exited = exitedWorktreeOf(result.output)
    if (exited !== undefined) {
      const draft: EventDraft = { type: 'worktree-exited', ...exited }
      return { drafts: [draft] }
    }

    return {}
  }
}
