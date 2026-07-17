import {
  assertValidCodexAuthJson,
  ensureCodexAuthHome,
  readCodexAuthHome,
} from '../codex-auth-home';
import type { EngineAuthAdapter } from '../engine-auth-adapter';

export const codexAuthAdapter: EngineAuthAdapter = {
  engine: 'codex',

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
