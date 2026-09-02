import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'

import {
  EMPTY_SETTINGS_DOCUMENT,
  parseSettingsDocument,
  serialiseSettingsDocument,
  type JsonValue,
  type SettingsDocument,
  type SettingsRead,
  type SettingsStorePort,
} from '@dltech/atlas-core'


const missing = (error: unknown): boolean =>
  typeof error === 'object' && error !== null && 'code' in error && error.code === 'ENOENT'

const messageOf = (error: unknown): string =>
  error instanceof Error ? error.message : 'unreadable'

export class FileSettingsStore implements SettingsStorePort {
  constructor(private readonly args: { file: string; label: string }) {}

  origin(): string {
    return this.args.label
  }

  read(): SettingsRead {
    let text: string
    try {
      text = readFileSync(this.args.file, 'utf8')
    } catch (error) {
      if (missing(error)) return { document: EMPTY_SETTINGS_DOCUMENT }
      return { document: EMPTY_SETTINGS_DOCUMENT, problem: `${this.args.label}: ${messageOf(error)}` }
    }

    let parsed: JsonValue
    try {
      parsed = JSON.parse(text) as JsonValue
    } catch (error) {
      return {
        document: EMPTY_SETTINGS_DOCUMENT,
        problem: `${this.args.label} is not valid json: ${messageOf(error)}`,
      }
    }

    return { document: parseSettingsDocument(parsed) }
  }

  /**
   * Written beside the target and renamed in, because rename is the only filesystem operation that
   * is atomic across the platforms Atlas runs on: a crash mid-write must never leave a half file.
   */
  write(document: SettingsDocument): void {
    const staging = `${this.args.file}.writing`
    mkdirSync(dirname(this.args.file), { recursive: true })
    writeFileSync(staging, serialiseSettingsDocument(document), 'utf8')
    renameSync(staging, this.args.file)
  }
}
