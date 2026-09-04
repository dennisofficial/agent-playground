import { randomUUID } from 'node:crypto'
import { join } from 'node:path'

import { EKilledBy, EStopAction, type ClockPort, type EventDraft, type ThreadId } from '@dltech/atlas-core'

import { ServiceNoticeQueue } from './service-notices'
import {
  SERVICE_SETTLE_MS,
  startService,
  type Service,
  type ServiceSnapshot,
} from './service-process'

export const CLOSE_GRACE_MS = 300
export const KILLED_GRACE_MS = 5_000

export type StartedServiceOutcome =
  | { ok: true; snapshot: ServiceSnapshot }
  | { ok: false; reason: string }

export type ServiceStopOutcome =
  | { ok: true; snapshot: ServiceSnapshot; action: EStopAction }
  | { ok: false; reason: string }

/**
 * A service is session-wide infrastructure rather than one thread's work: it outlives the turn that
 * started it by design, so any conversation may list or stop it. The starting thread is recorded
 * only so its ending routes to the log of the thread that started it.
 */
export abstract class ServiceRegistryPort {
  abstract start(args: {
    threadId: ThreadId
    command: string
    description: string
    cwd?: string | undefined
  }): Promise<StartedServiceOutcome>
  abstract stop(args: { serviceId: string; by: EKilledBy }): ServiceStopOutcome
  abstract list(): readonly ServiceSnapshot[]
  abstract version(): number
  abstract subscribe(listener: () => void): () => void
  abstract drainNotifications(args: { threadId: ThreadId }): readonly EventDraft[]
  abstract pendingNotices(args: { threadId: ThreadId }): readonly ServiceSnapshot[]
  abstract threadsAwaitingNotice(): readonly ThreadId[]
  abstract onNotice(listener: () => void): () => void
  abstract forgetNotices(args: { threadId: ThreadId }): void
  abstract closeAll(): Promise<void>
}

type Tracked = { service: Service; threadId: ThreadId; announced: boolean }

const unknownService = (args: { serviceId: string; known: readonly string[] }): string => {
  const known = args.known.length === 0 ? 'none is registered' : args.known.join(', ')
  return `no service is registered as "${args.serviceId}"; known services: ${known}`
}

const within = async (ms: number, promise: Promise<unknown>): Promise<void> => {
  let timer: ReturnType<typeof setTimeout> | undefined
  const grace = new Promise<void>((resolve) => {
    timer = setTimeout(resolve, ms)
  })
  await Promise.race([promise.then(() => undefined).catch(() => undefined), grace])
  clearTimeout(timer)
}

export class BunServiceRegistry extends ServiceRegistryPort {
  private readonly tracked = new Map<string, Tracked>()
  private readonly notices = new ServiceNoticeQueue()
  /**
   * Ids restart at svc_1 in every session, but the log directory is shared — the token keeps two
   * live sessions from writing the same file, and the shim resolves a bare id to its newest match.
   */
  private readonly sessionToken = randomUUID().slice(0, 8)
  private started = 0

  private revision = 0
  private readonly listeners = new Set<() => void>()
  private flushQueued = false

  constructor(
    private readonly root: string,
    private readonly clock: ClockPort,
    private readonly logsDirectory: string,
  ) {
    super()
  }

  /**
   * The settle wait is not a health check: it exists so a start that was never viable
   * (`command not found`) comes back as an immediate exit rather than a lying "Started".
   */
  async start(args: {
    threadId: ThreadId
    command: string
    description: string
    cwd?: string | undefined
  }): Promise<StartedServiceOutcome> {
    this.started += 1
    const serviceId = `svc_${this.started}`

    const opened = startService({
      serviceId,
      command: args.command,
      description: args.description,
      cwd: args.cwd ?? this.root,
      logPath: join(this.logsDirectory, `${serviceId}.${this.sessionToken}.log`),
      clock: this.clock,
      onExit: (service) => this.announceExit(service),
    })
    if (!opened.ok) return opened

    this.tracked.set(serviceId, {
      service: opened.service,
      threadId: args.threadId,
      announced: false,
    })
    this.bump()

    await within(SERVICE_SETTLE_MS, opened.service.exited)

    return { ok: true, snapshot: opened.service.snapshot() }
  }

  version(): number {
    return this.revision
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  private bump(): void {
    this.revision += 1
    if (this.flushQueued) return
    this.flushQueued = true
    queueMicrotask(() => {
      this.flushQueued = false
      for (const listener of this.listeners) listener()
    })
  }

  stop({ serviceId, by }: { serviceId: string; by: EKilledBy }): ServiceStopOutcome {
    const entry = this.tracked.get(serviceId)
    if (entry === undefined) {
      return { ok: false, reason: unknownService({ serviceId, known: [...this.tracked.keys()] }) }
    }

    const action = entry.service.stop(by)
    return { ok: true, snapshot: entry.service.snapshot(), action }
  }

  list(): readonly ServiceSnapshot[] {
    return [...this.tracked.values()].map((entry) => entry.service.snapshot())
  }

  drainNotifications({ threadId }: { threadId: ThreadId }): readonly EventDraft[] {
    return this.notices.drain({ threadId })
  }

  pendingNotices({ threadId }: { threadId: ThreadId }): readonly ServiceSnapshot[] {
    return this.notices.pending({ threadId })
  }

  threadsAwaitingNotice(): readonly ThreadId[] {
    return this.notices.threadsAwaiting()
  }

  onNotice(listener: () => void): () => void {
    return this.notices.onNotice(listener)
  }

  forgetNotices({ threadId: threadIdToForget }: { threadId: ThreadId }): void {
    this.notices.forget({ threadId: threadIdToForget })
  }

  /**
   * Teardown stops everything but suppresses nothing: every ending still queues, and the
   * composition root drains it into the owning thread's log before the database goes.
   */
  async closeAll(): Promise<void> {
    const entries = [...this.tracked.values()]
    for (const entry of entries) entry.service.stop(EKilledBy.SessionEnd)
    await Promise.all(entries.map((entry) => within(CLOSE_GRACE_MS, entry.service.exited)))
    for (const entry of entries) entry.service.stop(EKilledBy.SessionEnd)
    await Promise.all(entries.map((entry) => within(KILLED_GRACE_MS, entry.service.exited)))
    this.tracked.clear()
    this.listeners.clear()
  }

  private announceExit(service: Service): void {
    const entry = this.tracked.get(service.serviceId)
    if (entry === undefined || entry.announced) return

    entry.announced = true
    this.bump()
    this.notices.queue({ snapshot: service.snapshot(), threadId: entry.threadId })
  }
}
