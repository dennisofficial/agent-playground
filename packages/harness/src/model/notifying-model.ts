import type { LanguageModelV4, LanguageModelV4StreamPart } from '@ai-sdk/provider'

export type ModelFault = {
  providerId: string
  modelId: string
  fault: unknown
}

function errorChunkTap(
  report: (fault: unknown) => void,
): TransformStream<LanguageModelV4StreamPart, LanguageModelV4StreamPart> {
  let reported = false

  return new TransformStream<LanguageModelV4StreamPart, LanguageModelV4StreamPart>({
    transform(chunk, controller) {
      if (chunk.type === 'error' && !reported) {
        reported = true
        report(chunk.error)
      }
      controller.enqueue(chunk)
    },
  })
}

export function createNotifyingModel(args: {
  model: LanguageModelV4
  onFault: (fault: ModelFault) => void
}): LanguageModelV4 {
  const report = (fault: unknown): void => {
    try {
      args.onFault({ providerId: args.model.provider, modelId: args.model.modelId, fault })
    } catch {
      return
    }
  }

  return {
    specificationVersion: 'v4',
    get provider() {
      return args.model.provider
    },
    get modelId() {
      return args.model.modelId
    },
    get supportedUrls() {
      return args.model.supportedUrls
    },
    doGenerate: async (options) => {
      try {
        return await args.model.doGenerate(options)
      } catch (fault) {
        report(fault)
        throw fault
      }
    },
    doStream: async (options) => {
      try {
        const result = await args.model.doStream(options)
        return { ...result, stream: result.stream.pipeThrough(errorChunkTap(report)) }
      } catch (fault) {
        report(fault)
        throw fault
      }
    },
  }
}
