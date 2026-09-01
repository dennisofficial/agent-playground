export type ModelRef = {
  providerId: string
  modelId: string
}

export const refKey = (ref: ModelRef): string => `${ref.providerId}/${ref.modelId}`

export function parseRef(reference: string): ModelRef | undefined {
  const separator = reference.indexOf('/')
  if (separator < 0) return undefined

  const providerId = reference.slice(0, separator)
  const modelId = reference.slice(separator + 1)
  if (providerId.length === 0 || modelId.length === 0) return undefined

  return { providerId, modelId }
}
