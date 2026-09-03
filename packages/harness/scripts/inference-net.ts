import { z } from 'zod'

export const INFERENCE_MODELS_URL = 'https://api.inference.net/v1/models'
export const INFERENCE_SOURCE = 'api.inference.net'

const modelSchema = z.object({
  id: z.string(),
  context_length: z.number().optional(),
  max_completion_tokens: z.number().optional(),
  reasoning_efforts: z.array(z.string()).optional(),
  input_modalities: z.array(z.string()).optional(),
  supported_endpoints: z.array(z.string()).optional(),
  pricing: z
    .object({
      prompt: z.string().optional(),
      completion: z.string().optional(),
    })
    .optional(),
})

const listSchema = z.object({ data: z.array(modelSchema) })

export type InferenceModel = z.infer<typeof modelSchema>

export async function fetchInferenceModels(
  url: string = INFERENCE_MODELS_URL,
): Promise<readonly InferenceModel[]> {
  const response = await fetch(url)
  if (!response.ok) {
    throw new Error(`${url} answered ${response.status} ${response.statusText}`)
  }

  return listSchema.parse(await response.json()).data
}
