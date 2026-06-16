export type StageMode = 'plan' | 'execute' | 'investigate';

export interface PipelineStage {
  role: string;
  mode: StageMode;
  gate?: 'plan' | 'pr';
}

export interface PipelineDefinition {
  name: string;
  description?: string;
  stages: PipelineStage[];
}

/** DI token the runner module binds to the list of pipeline definitions. */
export const PIPELINE_DEFINITIONS = Symbol('PIPELINE_DEFINITIONS');
