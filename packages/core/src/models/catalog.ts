export enum EModelVendor {
  Anthropic = 'anthropic',
  OpenAI = 'openai',
}

export enum EEffort {
  Low = 'low',
  Medium = 'medium',
  High = 'high',
}

/**
 * How a model's thinking is asked for. Anthropic's `thinking.type=enabled` with a token budget is
 * deprecated from Sonnet 4.6 and Opus 4.6 onward in favour of an effort level, and rejected outright
 * by the older models the other way around.
 */
export enum EThinkingControl {
  Budget = 'budget',
  Effort = 'effort',
}

export type ModelEntry = {
  id: string
  label: string
  vendor: EModelVendor
  contextWindow: number
  thinkingControl: EThinkingControl
  inputPricePerMillion: number
  outputPricePerMillion: number
}

export type ContextPressure = {
  used: number
  window: number
  fraction: number
  percent: number
}
