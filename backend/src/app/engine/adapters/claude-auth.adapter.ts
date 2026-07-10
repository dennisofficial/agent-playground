import { readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { applyClaudeAuth } from '../claude-auth';
import { atlasEngineHomeDir, type EngineHomeKey } from '../engine-home';
import type { EngineAuthAdapter } from '../engine-auth-adapter';
import { isNewerClaudeCredential } from '../../onboarding/claude-credential-freshness';

const CREDENTIALS_FILENAME = '.credentials.json';

function credentialsFile(homeRoot: string | undefined, key: EngineHomeKey): string {
  return join(atlasEngineHomeDir(homeRoot, 'claude', key), CREDENTIALS_FILENAME);
}

function validate(secret: string): void {
  let accessToken: unknown;
  try {
    accessToken = (JSON.parse(secret) as { claudeAiOauth?: { accessToken?: unknown } }).claudeAiOauth?.accessToken;
  } catch {
    throw new Error(
      'Claude personal credential is invalid: not valid JSON (expected {claudeAiOauth:{accessToken,...}}).',
    );
  }
  if (typeof accessToken !== 'string' || accessToken.length === 0) {
    throw new Error(
      'Claude personal credential is invalid: missing claudeAiOauth.accessToken — re-authenticate the ' +
        'Claude account and re-store the full OAuth credential.',
    );
  }
}

/**
 * The Claude {@link EngineAuthAdapter}. Two delivery mechanisms, chosen by `kind`:
 *   - `'personal'` (an OAuth login): written as `<configDir>/.credentials.json` so the Claude Agent SDK
 *     itself refreshes the token and rewrites the file. `CLAUDE_CODE_OAUTH_TOKEN` OUTRANKS the file in the
 *     CLI's auth precedence, so it MUST be absent — setting it would pin the turn to a static token and
 *     silently suppress the SDK's own refresh.
 *   - `'setup-token'` (or undefined, the legacy default): a static env var via `applyClaudeAuth` — no
 *     file, no self-refresh. Any stale `.credentials.json` from a prior personal run is removed so a later
 *     read-back can't misfire against it.
 */
export const claudeAuthAdapter: EngineAuthAdapter = {
  engine: 'claude',

  materialize({ homeRoot, key, secret, kind, env }) {
    const dir = atlasEngineHomeDir(homeRoot, 'claude', key);
    const credFile = join(dir, CREDENTIALS_FILENAME);
    if (kind === 'personal') {
      // Fail fast with an actionable message (mirroring Codex's pre-write `assertValidCodexAuthJson`) rather
      // than writing a corrupt blob and letting it surface as an opaque error deep in the SDK/CLI.
      validate(secret);
      delete env.CLAUDE_CODE_OAUTH_TOKEN;
      delete env.ANTHROPIC_API_KEY;
      delete env.ANTHROPIC_AUTH_TOKEN;
      writeFileSync(credFile, secret, { mode: 0o600 });
    } else {
      rmSync(credFile, { force: true });
      applyClaudeAuth(env, { secret });
    }
    return dir;
  },

  readBackRefresh({ homeRoot, key, writtenSecret }) {
    try {
      const after = readFileSync(credentialsFile(homeRoot, key), 'utf8');
      if (!after || after === writtenSecret) return undefined;
      validate(after);
      if (!isNewerClaudeCredential(after, writtenSecret)) return undefined;
      return after;
    } catch {
      return undefined;
    }
  },
};
