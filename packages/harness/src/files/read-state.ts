import { resolve } from 'node:path'

import type { ThreadId } from '@dltech/atlas-core'

import { injectable } from '../container/injection'

export type FileView = { mtimeMs: number; size: number; wholeFile: boolean; digest: string }

export type FileViewKey = { threadId: ThreadId; path: string }

export abstract class FileReadStatePort {
  abstract record(args: FileViewKey & { view: FileView }): void
  abstract viewOf(args: FileViewKey): FileView | undefined
}

@injectable()
export class InMemoryFileReadState extends FileReadStatePort {
  private readonly byThread = new Map<ThreadId, Map<string, FileView>>()

  record({ threadId, path, view }: FileViewKey & { view: FileView }): void {
    const views = this.byThread.get(threadId) ?? new Map<string, FileView>()
    views.set(resolve(path), view)
    this.byThread.set(threadId, views)
  }

  viewOf({ threadId, path }: FileViewKey): FileView | undefined {
    return this.byThread.get(threadId)?.get(resolve(path))
  }
}
