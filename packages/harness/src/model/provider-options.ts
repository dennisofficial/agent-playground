import type { SharedV4ProviderMetadata } from '@ai-sdk/provider'
import type { JsonValue, ProviderOptions } from '@dltech/atlas-core'

import { toCoreJsonValue } from './json-value'

export function toCoreProviderOptions(metadata: SharedV4ProviderMetadata | undefined): ProviderOptions | undefined {
  if (metadata === undefined) return undefined

  const converted: Record<string, Record<string, JsonValue>> = {}
  for (const [namespace, values] of Object.entries(metadata)) {
    const namespaced: Record<string, JsonValue> = {}
    for (const [key, value] of Object.entries(values)) {
      if (value === undefined) continue
      namespaced[key] = toCoreJsonValue(value)
    }
    converted[namespace] = namespaced
  }
  return converted
}

export function mergeProviderOptions(args: {
  base: ProviderOptions | undefined
  incoming: ProviderOptions | undefined
}): ProviderOptions | undefined {
  const { base, incoming } = args
  if (base === undefined) return incoming
  if (incoming === undefined) return base

  const merged: Record<string, Record<string, JsonValue>> = { ...base }
  for (const [namespace, values] of Object.entries(incoming)) {
    const existing = merged[namespace]
    merged[namespace] = existing === undefined ? { ...values } : { ...existing, ...values }
  }
  return merged
}

export const carriedProviderOptions = (providerOptions: ProviderOptions | undefined) =>
  providerOptions === undefined ? {} : { providerOptions }
