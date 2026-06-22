import type { EnvService } from '@core/config/env/env.service';
import type { EngineAuth } from '../engine/engine.types';

/**
 * Derive an {@link EngineAuth} from the AMBIENT ENV — the single source of truth for the env-fallback
 * path, extracted verbatim from `EngineRunner.resolveAuth` so the runner and the per-tenant
 * `CredentialResolver` can NEVER drift. The contract (do not change without changing both callers):
 *  - `ATLAS_ENGINE_AUTH_MODE=subscription` + Claude + `ATLAS_CLAUDE_OAUTH_TOKEN` set → subscription;
 *    if the OAuth token is unset, warn and fall back to api_key (never crash).
 *  - Codex subscription has no env-configured auth.json overlay → api_key.
 *  - otherwise api_key with `ANTHROPIC_API_KEY` (which may be undefined → the engine uses ambient env).
 */
export function engineAuthFromEnv(
  env: EnvService,
  engine: 'claude' | 'codex',
  warn?: (message: string) => void,
): EngineAuth {
  const mode = env.get('ATLAS_ENGINE_AUTH_MODE') ?? 'api_key';
  if (mode === 'subscription') {
    if (engine === 'claude') {
      const secret = env.get('ATLAS_CLAUDE_OAUTH_TOKEN');
      if (secret) return { mode: 'subscription', secret };
      warn?.(
        'ATLAS_ENGINE_AUTH_MODE=subscription but ATLAS_CLAUDE_OAUTH_TOKEN unset — falling back to api_key',
      );
    }
    // Codex subscription needs an auth.json overlay that isn't env-configured → api_key.
  }
  return { mode: 'api_key', apiKey: env.get('ANTHROPIC_API_KEY') };
}
