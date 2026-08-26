import type { SettingsDocument, SettingsRead } from '../settings/document'

export interface SettingsStorePort {
  origin(): string
  read(): SettingsRead
  write(document: SettingsDocument): void
}
