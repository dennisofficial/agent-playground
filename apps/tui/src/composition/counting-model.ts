import {
  addPerfCounter,
  adjustPerfGauge,
  EPerfGauge,
  modelCallKey,
  modelChunkKey,
  modelStreamKey,
  type EPerfModelRole,
} from '@dltech/atlas-core'
import type { LanguageModelV4 } from '@dltech/atlas-harness'

const depth = (delta: number): void =>
  adjustPerfGauge({ key: EPerfGauge.ModelStreamDepth, delta })

/**
 * Background models (titler, summariser, tldr) never touch the turn driver or the delta channel,
 * so the turn/chunk counters cannot see them. This wrapper counts their traffic under per-role
 * keys, which is what lets a hot idle window say "the tldr model was streaming" instead of "unknown".
 */
export function countModelTraffic(args: {
  model: LanguageModelV4
  role: EPerfModelRole
}): LanguageModelV4 {
  const { model, role } = args

  return {
    specificationVersion: model.specificationVersion,
    provider: model.provider,
    modelId: model.modelId,
    get supportedUrls() {
      return model.supportedUrls
    },
    doGenerate: async (options) => {
      addPerfCounter({ key: modelCallKey(role) })
      depth(1)
      try {
        return await model.doGenerate(options)
      } finally {
        depth(-1)
      }
    },
    doStream: async (options) => {
      addPerfCounter({ key: modelStreamKey(role) })
      depth(1)
      const counting = new TransformStream({
        transform: (part, controller) => {
          addPerfCounter({ key: modelChunkKey(role) })
          controller.enqueue(part)
        },
        flush: () => depth(-1),
      })
      try {
        const result = await model.doStream(options)
        return { ...result, stream: result.stream.pipeThrough(counting) }
      } catch (error) {
        depth(-1)
        throw error
      }
    },
  }
}
