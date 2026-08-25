export enum ERuleFailurePolicy {
  Throw = 'throw',
  SkipRule = 'skip-rule',
}

export enum EAssemblyStage {
  Rule = 'rule',
  Annotator = 'annotator',
}

export type AssemblyTraceStep = {
  stage: EAssemblyStage
  name: string
  systemBlocks: number
  messages: number
  tokens: number
  failure?: string | undefined
}

export type AssemblyTrace = readonly AssemblyTraceStep[]
