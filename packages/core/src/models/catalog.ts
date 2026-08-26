export enum EModelVendor {
  Anthropic = 'anthropic',
  OpenAI = 'openai',
}

export enum EEffort {
  Low = 'low',
  Medium = 'medium',
  High = 'high',
}

export type ModelEntry = {
  id: string
  label: string
  vendor: EModelVendor
  contextWindow: number
  inputPricePerMillion: number
  outputPricePerMillion: number
}

export type ContextPressure = {
  used: number
  window: number
  fraction: number
  percent: number
}
