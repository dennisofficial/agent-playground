import { z } from 'zod'

export const MODELS_DEV_URL = 'https://models.dev/api.json'
export const MODELS_DEV_SOURCE = 'models.dev'

const reasoningOptionSchema = z.object({
  type: z.string(),
  values: z.array(z.string().nullable()).optional(),
  min: z.number().optional(),
  max: z.number().optional(),
})

const modelSchema = z.object({
  id: z.string(),
  name: z.string().optional(),
  status: z.string().optional(),
  reasoning: z.boolean().optional(),
  reasoning_options: z.array(reasoningOptionSchema).optional(),
  tool_call: z.boolean().optional(),
  limit: z
    .object({
      context: z.number().optional(),
      output: z.number().optional(),
    })
    .optional(),
  cost: z
    .object({
      input: z.number().optional(),
      output: z.number().optional(),
    })
    .optional(),
})

const providerSchema = z.object({
  id: z.string(),
  name: z.string().optional(),
  npm: z.string().optional(),
  models: z.record(z.string(), modelSchema),
})

const indexSchema = z.record(z.string(), providerSchema)

export type ModelsDevModel = z.infer<typeof modelSchema>
export type ModelsDevProvider = z.infer<typeof providerSchema>
export type ModelsDevIndex = z.infer<typeof indexSchema>

export async function fetchModelsDevIndex(url: string = MODELS_DEV_URL): Promise<ModelsDevIndex> {
  const response = await fetch(url)
  if (!response.ok) {
    throw new Error(`${url} answered ${response.status} ${response.statusText}`)
  }

  return indexSchema.parse(await response.json())
}
