import type { EnvService } from '@core/config/env/env.service';
import type { EngineAuth } from '../engine/engine.types';

/**
 * Derive the SDK harness's subscription secret from the AMBIENT ENV — the env-fallback for local dev,
 * used by `CredentialResolver.engineAuth` when an org has no per-engine secret. Subscription-only: the
 * harness never runs on an API key. Claude reads `CLAUDE_OAUTH_TOKEN`, Codex reads `CODEX_OAUTH_TOKEN`.
 * Returns `undefined` when unset → the caller omits `auth` and the engine throws (no API-key fallback).
 */
export function engineAuthFromEnv(
  env: EnvService,
  engine: 'claude' | 'codex',
): EngineAuth | undefined {
  const secret = engine === 'claude' ? env.get('CLAUDE_OAUTH_TOKEN') : env.get('CODEX_OAUTH_TOKEN');
  return secret ? { secret } : undefined;
}
