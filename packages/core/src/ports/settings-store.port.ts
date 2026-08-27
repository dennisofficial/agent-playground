import type { SettingsDocument, SettingsRead } from '../settings/document'

export abstract class SettingsStorePort {
  abstract origin(): string
  abstract read(): SettingsRead
  abstract write(document: SettingsDocument): void
}
