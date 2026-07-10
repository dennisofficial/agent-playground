import {
  assertValidCodexAuthJson,
  CodexAuthInvalidError,
  ensureCodexAuthHome,
  readCodexAuthHome,
} from '../codex-auth-home';
import { isNewerCodexAuth } from '../../onboarding/codex-auth-freshness';
import type { EngineAuthAdapter } from '../engine-auth-adapter';

/**
 * The Codex {@link EngineAuthAdapter} — a thin, behavior-preserving wrapper around the existing
 * `auth.json` overlay-home mechanics (`ensureCodexAuthHome` / `readCodexAuthHome` /
 * `assertValidCodexAuthJson` / `isNewerCodexAuth`). No MCP-bridge wiring here — `runCodex` still calls
 * `ensureCodexAuthHome` directly (with the bridge/extra-servers args) for the actual client home; this
 * adapter exists so the auth-only lifecycle (validate/materialize/read-back) is reachable through the
 * same engine-agnostic seam Claude uses.
 */
export const codexAuthAdapter: EngineAuthAdapter = {
  engine: 'codex',

  validate(secret) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(secret);
    } catch {
      throw new CodexAuthInvalidError('not valid JSON (expected the full auth.json object)');
    }
    assertValidCodexAuthJson(parsed);
  },

  isNewer(candidate, current) {
    return isNewerCodexAuth(candidate, current);
  },

  materialize({ homeRoot, key, secret }) {
    return ensureCodexAuthHome(homeRoot, key, secret);
  },

  readBackRefresh({ homeRoot, key, writtenSecret }) {
    try {
      const after = readCodexAuthHome(homeRoot, key);
      if (!after || after === writtenSecret) return undefined;
      assertValidCodexAuthJson(JSON.parse(after));
      return after;
    } catch {
      return undefined;
    }
  },
};
