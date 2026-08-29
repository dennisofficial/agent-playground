import {
  AfterToolHook,
  EStage,
  movedSessionDirectoryOf,
  type AfterTool,
  type HookOrder,
} from '@dltech/atlas-core'

import { injectable } from '../container/injection'

@injectable()
export class TrackSessionDirectoryHook extends AfterToolHook {
  readonly name = 'track-session-directory'
  readonly order: HookOrder = { stage: EStage.Observe, nudge: 0 }

  readonly run: AfterTool = async ({ result }) => {
    if (!result.ok) return {}

    const moved = movedSessionDirectoryOf(result.output)
    if (moved === undefined) return {}

    return { drafts: [{ type: 'cwd-changed', path: moved }] }
  }
}
