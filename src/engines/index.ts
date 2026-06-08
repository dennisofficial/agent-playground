import { claudeEngine } from './claude.js';
import { codexEngine } from './codex.js';
import { langgraphEngine } from './langgraph.js';
import type { WorkerEngine, WorkerEngineName } from './types.js';

export type { RunWorkerArgs, WorkerEngine, WorkerEngineName, WorkerEvent } from './types.js';

const ENGINES: Record<WorkerEngineName, WorkerEngine> = {
  claude: claudeEngine,
  codex: codexEngine,
  langgraph: langgraphEngine,
};

export const ENGINE_NAMES = Object.keys(ENGINES) as WorkerEngineName[];

export function getEngine(name: WorkerEngineName): WorkerEngine {
  return ENGINES[name];
}

/** Default engine for dispatched jobs: `WORKER_ENGINE` env if valid, else Claude. */
export function defaultEngine(): WorkerEngineName {
  const env = process.env.WORKER_ENGINE as WorkerEngineName | undefined;
  return env && env in ENGINES ? env : 'claude';
}
