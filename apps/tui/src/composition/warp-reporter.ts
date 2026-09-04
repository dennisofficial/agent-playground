import {
  AfterToolHook,
  buildWarpOscSequence,
  buildWarpPayload,
  EStage,
  eventsOfType,
  EWarpAgentEvent,
  negotiateWarpProtocolVersion,
  OnThreadOpenHook,
  rowsOwnedBy,
  summarizeWarpPermission,
  supportsWarpAgentNotifications,
  warpStopTexts,
  type AfterTool,
  type EventLogPort,
  type HookOutcome,
  type OnThreadOpen,
  type ThreadId,
  type WarpEventExtras,
  type WarpTerminalEnv,
} from '@dltech/atlas-core'
import { ETurnStatus, type TurnOutcome } from '@dltech/atlas-harness'

import type { ApprovalQuestion } from '../ui/approval-model'

export interface WarpReporter {
  handleThreadOpened(args: { threadId: ThreadId; projectDirectory: string }): void
  handlePromptSubmit(args: { text: string }): void
  handleToolComplete(args: { toolName: string }): void
  handlePermissionRequest(args: { summary: string; toolName: string; toolInput: unknown }): void
  handleTurnCompleted(args: { query: string; response: string }): void
}

class OscWarpReporter implements WarpReporter {
  private session: { threadId: ThreadId; cwd: string } | null = null

  constructor(
    private readonly args: {
      write: (sequence: string) => void
      protocolVersion: number
      version: string
    },
  ) {}

  handleThreadOpened(args: { threadId: ThreadId; projectDirectory: string }): void {
    this.session = { threadId: args.threadId, cwd: args.projectDirectory }
    this.tryEmit(EWarpAgentEvent.SessionStart, { pluginVersion: this.args.version })
  }

  handlePromptSubmit(args: { text: string }): void {
    this.tryEmit(EWarpAgentEvent.PromptSubmit, { query: args.text })
  }

  handleToolComplete(args: { toolName: string }): void {
    this.tryEmit(EWarpAgentEvent.ToolComplete, { toolName: args.toolName })
  }

  handlePermissionRequest(args: { summary: string; toolName: string; toolInput: unknown }): void {
    this.tryEmit(EWarpAgentEvent.PermissionRequest, {
      summary: args.summary,
      toolName: args.toolName,
      toolInput: args.toolInput,
    })
  }

  handleTurnCompleted(args: { query: string; response: string }): void {
    this.tryEmit(EWarpAgentEvent.Stop, { query: args.query, response: args.response })
  }

  private tryEmit(event: EWarpAgentEvent, extras: WarpEventExtras): void {
    const session = this.session
    if (session === null) return

    try {
      this.args.write(
        buildWarpOscSequence({
          payloadJson: buildWarpPayload({
            event,
            sessionId: session.threadId,
            cwd: session.cwd,
            protocolVersion: this.args.protocolVersion,
            extras,
          }),
        }),
      )
    } catch {
      // A notification channel must never take the session down with it.
    }
  }
}

export function createWarpReporter(args: {
  env: WarpTerminalEnv
  write: (sequence: string) => void
  version: string
}): WarpReporter | null {
  if (!supportsWarpAgentNotifications({ env: args.env })) return null
  return new OscWarpReporter({
    write: args.write,
    protocolVersion: negotiateWarpProtocolVersion({ env: args.env }),
    version: args.version,
  })
}

export class WarpThreadOpenHook extends OnThreadOpenHook {
  readonly name = 'warp-thread-open'
  readonly order = { stage: EStage.Observe, nudge: 0 }

  constructor(private readonly reporter: WarpReporter) {
    super()
  }

  readonly run = async (args: Parameters<OnThreadOpen>[0]): Promise<HookOutcome> => {
    this.reporter.handleThreadOpened(args)
    return {}
  }
}

export class WarpToolCompleteHook extends AfterToolHook {
  readonly name = 'warp-tool-complete'
  readonly order = { stage: EStage.Observe, nudge: 0 }

  constructor(private readonly reporter: WarpReporter) {
    super()
  }

  readonly run = async (args: Parameters<AfterTool>[0]): Promise<HookOutcome> => {
    this.reporter.handleToolComplete({ toolName: args.call.name })
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
    const toolName = call?.name ?? 'unknown'
    reporter.handlePermissionRequest({
      summary: summarizeWarpPermission({ toolName, toolInput: call?.input }),
      toolName,
      toolInput: call?.input,
    })
    return
  }

  if (args.outcome.status !== ETurnStatus.Completed) return

  const rows = rowsOwnedBy({
    events: await args.log.read({ threadId: args.threadId }),
    threadId: args.threadId,
  })
  const texts = warpStopTexts({ events: rows })
  if (texts !== undefined) reporter.handleTurnCompleted(texts)
}
