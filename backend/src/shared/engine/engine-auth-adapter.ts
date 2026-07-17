import type { SessionEngine } from '../domain';
import { claudeAuthAdapter } from './adapters/claude-auth.adapter';
import { codexAuthAdapter } from './adapters/codex-auth.adapter';
import type { EngineHomeKey } from './engine-home';

export type EngineAuthKind = 'setup-token' | 'personal';

export interface MaterializeArgs {
  homeRoot: string | undefined;
  key: EngineHomeKey;
  secret: string;
  kind?: EngineAuthKind;
  env: Record<string, string | undefined>;
}

export interface ReadBackArgs {
  homeRoot: string | undefined;
  key: EngineHomeKey;
  writtenSecret: string;
}

export interface EngineAuthAdapter {
  readonly engine: SessionEngine;
  materialize(args: MaterializeArgs): string;
  readBackRefresh(args: ReadBackArgs): string | undefined;
}

const ADAPTERS: Record<SessionEngine, EngineAuthAdapter> = {
  codex: codexAuthAdapter,
  claude: claudeAuthAdapter,
};

export function getEngineAuthAdapter(engine: SessionEngine): EngineAuthAdapter {
  return ADAPTERS[engine];
}
