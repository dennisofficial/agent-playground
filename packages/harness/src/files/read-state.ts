import { resolve } from 'node:path'

import { injectable } from '../container/injection'

export type FileView = { mtimeMs: number; size: number; wholeFile: boolean }

export abstract class FileReadStatePort {
  abstract record(args: { path: string; view: FileView }): void
  abstract viewOf(path: string): FileView | undefined
}

@injectable()
export class InMemoryFileReadState extends FileReadStatePort {
  private readonly views = new Map<string, FileView>()

  record({ path, view }: { path: string; view: FileView }): void {
    this.views.set(resolve(path), view)
  }

  viewOf(path: string): FileView | undefined {
    return this.views.get(resolve(path))
  }
}
