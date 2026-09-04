import {
  buildWarpCwdSequence,
  buildWarpNotificationSequence,
  EStage,
  eventsOfType,
  isWarpTerminal,
  OnThreadOpenHook,
  rowsOwnedBy,
  summarizeWarpPermission,
  truncateForWarpNotification,
  warpStopTexts,
  type EventLogPort,
  type HookOutcome,
  type OnThreadOpen,
  type ThreadId,
  type WarpTerminalEnv,
} from '@dltech/atlas-core'
import { ETurnStatus, type TurnOutcome } from '@dltech/atlas-harness'

import type { ApprovalQuestion } from '../ui/approval-model'

export interface WarpReporter {
  handleThreadOpened(args: { projectDirectory: string }): void
  handlePermissionRequest(args: { summary: string }): void
  handleTurnCompleted(args: { response: string }): void
}

class OscWarpReporter implements WarpReporter {
  private projectDirectory: string | null = null

  constructor(
    private readonly args: {
      write: (sequence: string) => void
      host: string
    },
  ) {}

  handleThreadOpened(args: { projectDirectory: string }): void {
    this.projectDirectory = args.projectDirectory
    this.tryWrite(
      buildWarpCwdSequence({ cwd: args.projectDirectory, host: this.args.host }),
    )
  }

  handlePermissionRequest(args: { summary: string }): void {
    this.notify(args.summary)
  }

  handleTurnCompleted(args: { response: string }): void {
    this.notify(truncateForWarpNotification({ text: args.response }))
  }

  private notify(body: string): void {
    if (body === '') return
    this.tryWrite(buildWarpNotificationSequence({ title: this.title(), body }))
  }

  private title(): string {
    const project = this.projectDirectory?.split('/').filter(Boolean).pop()
    return project === undefined ? 'Atlas' : `Atlas — ${project}`
  }

  private tryWrite(sequence: string): void {
    try {
      this.args.write(sequence)
    } catch {
      // A notification channel must never take the session down with it.
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

export async function reportWarpOutcome(args: {
  reporter: WarpReporter | null
  log: EventLogPort
  threadId: ThreadId
  outcome: TurnOutcome
  asked: ApprovalQuestion | null
}): Promise<void> {
  const { reporter } = args
  if (reporter === null) return

  if (args.asked !== null) {
    const rows = rowsOwnedBy({
      events: await args.log.read({ threadId: args.threadId }),
      threadId: args.threadId,
    })
    const call = eventsOfType({ events: rows, type: 'tool-called' })
      .filter((event) => event.callId === args.asked?.callId)
      .at(-1)
    reporter.handlePermissionRequest({
      summary: summarizeWarpPermission({
        toolName: call?.name ?? 'a tool',
        toolInput: call?.input,
      }),
    })
    return
  }

  if (args.outcome.status !== ETurnStatus.Completed) return

  const rows = rowsOwnedBy({
    events: await args.log.read({ threadId: args.threadId }),
    threadId: args.threadId,
  })
  const texts = warpStopTexts({ events: rows })
  if (texts !== undefined) reporter.handleTurnCompleted({ response: texts.response })
}
