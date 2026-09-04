import {
  buildWarpCwdSequence,
  EStage,
  isWarpTerminal,
  OnThreadOpenHook,
  type HookOutcome,
  type OnThreadOpen,
  type WarpTerminalEnv,
} from '@dltech/atlas-core'

export interface WarpReporter {
  handleThreadOpened(args: { projectDirectory: string }): void
}

class OscWarpReporter implements WarpReporter {
  constructor(
    private readonly args: {
      write: (sequence: string) => void
      host: string
    },
  ) {}

  handleThreadOpened(args: { projectDirectory: string }): void {
    try {
      this.args.write(buildWarpCwdSequence({ cwd: args.projectDirectory, host: this.args.host }))
    } catch {
      // A reporting channel must never take the session down with it.
    }
  }
}

export function createWarpReporter(args: {
  env: WarpTerminalEnv
  write: (sequence: string) => void
  host: string
}): WarpReporter | null {
  if (!isWarpTerminal({ env: args.env })) return null
  return new OscWarpReporter({ write: args.write, host: args.host })
}

export class WarpThreadOpenHook extends OnThreadOpenHook {
  readonly name = 'warp-thread-open'
  readonly order = { stage: EStage.Observe, nudge: 0 }

  constructor(private readonly reporter: WarpReporter) {
    super()
  }

  readonly run = async (args: Parameters<OnThreadOpen>[0]): Promise<HookOutcome> => {
    this.reporter.handleThreadOpened({ projectDirectory: args.projectDirectory })
    return {}
  }
}
