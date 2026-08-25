import type { JSONValue } from '@ai-sdk/provider'
import type { JsonValue } from '@dltech/atlas-core'

export function toCoreJsonValue(value: JSONValue): JsonValue {
  if (value === null || typeof value !== 'object') return value
  if (Array.isArray(value)) return value.map(toCoreJsonValue)

  const stripped: Record<string, JsonValue> = {}
  for (const [key, inner] of Object.entries(value)) {
    if (inner === undefined) continue
    stripped[key] = toCoreJsonValue(inner)
  }
  return stripped
}
