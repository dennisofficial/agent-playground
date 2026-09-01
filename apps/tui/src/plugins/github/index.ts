import { EHookPhase, EStage, type HookOrder } from '@dltech/atlas-core'
import { createUrlOpener, inject, injectable, WorkspaceRoot } from '@dltech/atlas-harness'

import { NativePlugin, type PluginContribution } from '../plugin'
import { GhPullRequestPort } from './gh-pull-requests'
import { RefreshPullRequestAfterShellHook, RefreshPullRequestAfterToolHook } from './hooks'
import { createPullRequestService } from './pull-request-service'
import { PullRequestPort } from './pure'
import { createSessionFacts } from './session'
import { pullRequestSurface } from './surface'

const OBSERVE: HookOrder = { stage: EStage.Observe, nudge: 0 }

/**
 * The port is constructed here and never injected: this plugin is what supplies `PullRequestPort`,
 * so asking the container for one would be asking for its own contribution. The launch directory is
 * injected because Atlas owns it.
 *
 * Nothing starts in the constructor. The loader builds every native before shadowing has decided
 * which of them survive, so a poller armed here would outlive a plugin that never loads.
 */
@injectable()
export default class GithubPlugin extends NativePlugin {
  readonly id = 'github'

  constructor(@inject(WorkspaceRoot) private readonly launchDirectory: string) {
    super()
  }

  contribute(): PluginContribution {
    const adapter = new GhPullRequestPort()
    const service = createPullRequestService({ pullRequests: adapter })
    const facts = createSessionFacts({ launchDirectory: this.launchDirectory })
    const afterTool = new RefreshPullRequestAfterToolHook({ pullRequests: service })
    const afterShell = new RefreshPullRequestAfterShellHook({ pullRequests: service })

    return {
      hooks: [
        {
          phase: EHookPhase.BeforeTurn,
          name: 'follow-session',
          order: OBSERVE,
          run: facts.beforeTurn,
        },
        {
          phase: EHookPhase.AfterTurn,
          name: 'turn-ended',
          order: OBSERVE,
          run: facts.afterTurn,
        },
        {
          phase: EHookPhase.AfterTool,
          name: afterTool.name,
          order: afterTool.order,
          run: afterTool.run,
        },
        {
          phase: EHookPhase.AfterShell,
          name: afterShell.name,
          order: afterShell.order,
          run: afterShell.run,
        },
      ],
      ports: [{ token: PullRequestPort, use: adapter }],
      surfaces: [pullRequestSurface({ service, facts, openUrl: createUrlOpener() })],
      dispose: () => service.dispose(),
    }
  }
}
