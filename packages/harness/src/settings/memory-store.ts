import {
  EMPTY_SETTINGS_DOCUMENT,
  type SettingsDocument,
  type SettingsRead,
  type SettingsStorePort,
} from '@dltech/atlas-core'

import { injectable } from '../container/injection'

@injectable()
export class MemorySettingsStore implements SettingsStorePort {
  private held: SettingsDocument

  constructor(
    private readonly args: {
      label?: string
      document?: SettingsDocument
      refuse?: string
      problem?: string
    } = {},
  ) {
    this.held = args.document ?? EMPTY_SETTINGS_DOCUMENT
  }

  origin(): string {
    return this.args.label ?? 'memory'
  }

  document(): SettingsDocument {
    return this.held
  }

  read(): SettingsRead {
    return {
      document: this.held,
      ...(this.args.problem === undefined ? {} : { problem: this.args.problem }),
    }
  }

  write(document: SettingsDocument): void {
    if (this.args.refuse !== undefined) throw new Error(this.args.refuse)
    this.held = document
  }
}
