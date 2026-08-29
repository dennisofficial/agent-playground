import { ClockPort, EKilledBy, type EventDraft } from '@dltech/atlas-core'

import { inject, injectable, portToken } from '../container/injection'
import { WorkspaceRoot } from '../container/tokens'
import { startBackgroundShell, type BackgroundShell, type ShellSnapshot } from './background-shell'
import { endedDraft } from './notifications'
import { toShellId, type ShellId } from './shell-id'

export const RETAINED_CHARACTERS = 400_000
export const OVERFLOW_CHARACTERS = 50_000_000
export const DELIVERED_CHARACTERS = 30_000

export type ShellDelta = {
  text: string
  droppedCharacters: number
  remainingCharacters: number
}

export type StartedShellOutcome = { ok: true; snapshot: ShellSnapshot } | { ok: false; reason: string }

export type ShellReadOutcome =
  | { ok: true; snapshot: ShellSnapshot; delta: ShellDelta }
  | { ok: false; reason: string }

export type ShellKillOutcome = { ok: true; snapshot: ShellSnapshot } | { ok: false; reason: string }

export abstract class ShellRegistryPort {
  abstract start(args: {
    command: string
    description?: string | undefined
    cwd?: string | undefined
  }): StartedShellOutcome
  abstract read(args: { shellId: string }): ShellReadOutcome
  abstract peek(args: { shellId: string; characters: number }): string | undefined
  abstract kill(args: { shellId: string; by: EKilledBy }): ShellKillOutcome
  abstract list(): readonly ShellSnapshot[]
  abstract drainNotifications(): readonly EventDraft[]
  abstract pendingNotices(): readonly ShellSnapshot[]
  abstract onNotice(listener: () => void): () => void
  abstract forgetNotices(): void
  abstract closeAll(): Promise<void>
}

type Tracked = { shell: BackgroundShell; cursor: number; announced: boolean }

/**
 * The delta is read when the ending is handed over rather than when the shell exits, so an ending
 * that is dropped rather than delivered leaves its output where shell_output can still find it.
 */
type Ending = { snapshot: ShellSnapshot; take: () => ShellDelta }

const NOTHING_PENDING: readonly Ending[] = Object.freeze([])

const NOTHING_ANNOUNCED: readonly ShellSnapshot[] = Object.freeze([])

const NOTHING_DRAINED: readonly EventDraft[] = Object.freeze([])

/**
 * The cursor is the model's place in a shell, so taking a delta is what marks output as delivered.
 */
function take(entry: Tracked): ShellDelta {
  const delta = entry.shell.since(entry.cursor)
  const text = delta.text.slice(0, DELIVERED_CHARACTERS)
  entry.cursor = entry.cursor + delta.droppedCharacters + text.length

  return {
    text,
    droppedCharacters: delta.droppedCharacters,
    remainingCharacters: Math.max(delta.totalCharacters - entry.cursor, 0),
  }
}

const unknownShell = (args: { shellId: string; known: readonly ShellId[] }): string => {
  const known = args.known.length === 0 ? 'none is running' : args.known.join(', ')
  return `no background shell is registered as "${args.shellId}"; known shells: ${known}`
}

@injectable()
export class BunShellRegistry extends ShellRegistryPort {
  private readonly tracked = new Map<ShellId, Tracked>()
  private endings: readonly Ending[] = NOTHING_PENDING
  private noticed: readonly ShellSnapshot[] = NOTHING_ANNOUNCED
  private readonly listeners = new Set<() => void>()
  private started = 0

  constructor(
    @inject(WorkspaceRoot) private readonly root: string,
    @inject(portToken(ClockPort)) private readonly clock: ClockPort,
  ) {
    super()
  }

  start(args: {
    command: string
    description?: string | undefined
    cwd?: string | undefined
  }): StartedShellOutcome {
    this.started += 1
    const shellId = toShellId(`bash_${this.started}`)

    const opened = startBackgroundShell({
      shellId,
      command: args.command,
      description: args.description,
      cwd: args.cwd ?? this.root,
      clock: this.clock,
      retainCharacters: RETAINED_CHARACTERS,
      overflowCharacters: OVERFLOW_CHARACTERS,
      onExit: (shell) => this.announceExit(shell),
    })
    if (!opened.ok) return opened

    this.tracked.set(shellId, { shell: opened.shell, cursor: 0, announced: false })

    return { ok: true, snapshot: opened.shell.snapshot() }
  }

  read({ shellId }: { shellId: string }): ShellReadOutcome {
    const entry = this.entryFor(shellId)
    if (entry === undefined) return { ok: false, reason: unknownShell({ shellId, known: this.ids() }) }

    return { ok: true, snapshot: entry.shell.snapshot(), delta: take(entry) }
  }

  /**
   * The cursor belongs to the model's reading of a shell, so a human looking at the same shell in
   * the sidebar must not advance it.
   */
  peek({ shellId, characters }: { shellId: string; characters: number }): string | undefined {
    return this.entryFor(shellId)?.shell.tail(characters)
  }

  kill({ shellId, by }: { shellId: string; by: EKilledBy }): ShellKillOutcome {
    const entry = this.entryFor(shellId)
    if (entry === undefined) return { ok: false, reason: unknownShell({ shellId, known: this.ids() }) }

    entry.shell.kill(by)
    return { ok: true, snapshot: entry.shell.snapshot() }
  }

  list(): readonly ShellSnapshot[] {
    return [...this.tracked.values()].map((entry) => entry.shell.snapshot())
  }

  drainNotifications(): readonly EventDraft[] {
    const handed = this.endings
    if (handed.length === 0) return NOTHING_DRAINED

    this.settleEndings(NOTHING_PENDING)
    return handed.map((ending) => endedDraft({ snapshot: ending.snapshot, delta: ending.take() }))
  }

  pendingNotices(): readonly ShellSnapshot[] {
    return this.noticed
  }

  onNotice(listener: () => void): () => void {
    this.listeners.add(listener)
    return () => void this.listeners.delete(listener)
  }

  forgetNotices(): void {
    if (this.endings.length === 0) return

    this.settleEndings(NOTHING_PENDING)
  }

  /**
   * Reaping is by spawner rather than by process tree: a shell the model backgrounded outlives the
   * turn by design, so only the session that started it knows when nobody is left to read it.
   * Teardown kills, but it does not suppress: every ending announces itself, including this one.
   */
  async closeAll(): Promise<void> {
    const running = [...this.tracked.values()]
    for (const entry of running) entry.shell.kill(EKilledBy.SessionEnd)
    await Promise.all(running.map((entry) => entry.shell.exited))
    this.tracked.clear()
  }

  private ids(): readonly ShellId[] {
    return [...this.tracked.keys()]
  }

  private entryFor(shellId: string): Tracked | undefined {
    for (const [id, entry] of this.tracked) if (id === shellId) return entry
    return undefined
  }

  private announceExit(shell: BackgroundShell): void {
    const entry = this.tracked.get(shell.shellId)
    if (entry === undefined || entry.announced) return

    entry.announced = true
    this.settleEndings([...this.endings, { snapshot: shell.snapshot(), take: () => take(entry) }])
  }

  /**
   * The snapshots are held rather than derived per call: pendingNotices backs a React external
   * store, which reads it on every render and requires a stable value between changes.
   */
  private settleEndings(endings: readonly Ending[]): void {
    this.endings = endings
    this.noticed =
      endings.length === 0 ? NOTHING_ANNOUNCED : endings.map((ending) => ending.snapshot)

    for (const listener of [...this.listeners]) listener()
  }
}
