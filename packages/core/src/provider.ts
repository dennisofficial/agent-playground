import type { JsonValue } from './json'

export type ProviderOptions = Record<string, Record<string, JsonValue>>

export type ProviderIdentity = { id: string; modelId: string }
