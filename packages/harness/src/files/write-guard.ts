import { stat } from 'node:fs/promises'

import type { ThreadId } from '@dltech/atlas-core'

import { inject, injectable, portToken } from '../container/injection'
import { withPathLock } from './path-lock'
import { FileReadStatePort } from './read-state'
import { movedSince } from './staleness'

export type GuardedWrite<T> = { ok: true; value: T } | { ok: false; reason: string }

const overtakenBy = (path: string): string =>
  `${path} changed while this write was being prepared, so nothing was written rather than overwrite what landed there; read it again before writing to it`

export abstract class FileWriteGuardPort {
  abstract underLock<T>(args: {
    threadId: ThreadId
    path: string
    write: () => Promise<T>
  }): Promise<GuardedWrite<T>>
}

export class SerializedWrites extends FileWriteGuardPort {
  async underLock<T>({
    path,
    write,
  }: {
    threadId: ThreadId
    path: string
    write: () => Promise<T>
  }): Promise<GuardedWrite<T>> {
    return await withPathLock({ path, run: async () => ({ ok: true, value: await write() }) })
  }
}

@injectable()
export class VerifyingWriteGuard extends FileWriteGuardPort {
  constructor(@inject(portToken(FileReadStatePort)) private readonly seen: FileReadStatePort) {
    super()
  }

  async underLock<T>({
    threadId,
    path,
    write,
  }: {
    threadId: ThreadId
    path: string
    write: () => Promise<T>
  }): Promise<GuardedWrite<T>> {
    return await withPathLock({
      path,
      run: async () => {
        if (await this.overtaken({ threadId, path })) {
          return { ok: false, reason: overtakenBy(path) }
        }

        return { ok: true, value: await write() }
      },
    })
  }

  private async overtaken({
    threadId,
    path,
  }: {
    threadId: ThreadId
    path: string
  }): Promise<boolean> {
    const view = this.seen.viewOf({ threadId, path })
    if (view === undefined) return false

    const stats = await stat(path).catch(() => null)
    if (stats === null || !stats.isFile()) return false

    return await movedSince({ view, stats, path })
  }
}
