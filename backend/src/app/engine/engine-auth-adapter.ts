import type { SessionEngine } from '../domain';
import type { EngineHomeKey } from './engine-home';
import { claudeAuthAdapter } from './adapters/claude-auth.adapter';
import { codexAuthAdapter } from './adapters/codex-auth.adapter';

/**
 * The engine-agnostic seam for a subscription-auth turn's ENGINE-side mechanics — materializing a
 * secret into the isolated engine home (a file, an env var, or both) before the turn, and reading a
 * possibly-rotated secret back after. Both engines share the exact same lifecycle (materialize → run →
 * read-back → best-effort write-back), so this registry unifies that shape; STORAGE (how a refreshed
 * secret gets persisted to its durable credential row) stays per-engine and lives one layer up, in the
 * onboarding `AuthRefreshSink`.
 */
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
  /** Throws a clear, actionable error when `secret` isn't a usable credential for this engine. */
  validate(secret: string): void;
  /** Whether `candidate` is a strictly newer credential than `current`. */
  isNewer(candidate: string, current: string): boolean;
  /** Write the credential file(s) into the engine home and/or mutate `env` as needed. Returns the home dir. */
  materialize(args: MaterializeArgs): string;
  /** Read a possibly-rotated credential back after a turn. Undefined when unchanged/absent/invalid. */
  readBackRefresh(args: ReadBackArgs): string | undefined;
}

const ADAPTERS: Record<SessionEngine, EngineAuthAdapter> = {
  codex: codexAuthAdapter,
  claude: claudeAuthAdapter,
};

/** Resolve the {@link EngineAuthAdapter} for a given engine. */
export function getEngineAuthAdapter(engine: SessionEngine): EngineAuthAdapter {
  return ADAPTERS[engine];
}
