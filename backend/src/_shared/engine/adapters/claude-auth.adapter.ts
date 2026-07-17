import { readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { isNewerClaudeCredential } from '../../onboarding/claude-credential-freshness';
import { applyClaudeAuth } from '../claude-auth';
import type { EngineAuthAdapter } from '../engine-auth-adapter';
import { atlasEngineHomeDir, type EngineHomeKey } from '../engine-home';

const CREDENTIALS_FILENAME = '.credentials.json';

function credentialsFile(homeRoot: string | undefined, key: EngineHomeKey): string {
  return join(atlasEngineHomeDir(homeRoot, 'claude', key), CREDENTIALS_FILENAME);
}

function validate(secret: string): void {
  let accessToken: unknown;
  try {
    accessToken = (JSON.parse(secret) as { claudeAiOauth?: { accessToken?: unknown } })
      .claudeAiOauth?.accessToken;
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

export const claudeAuthAdapter: EngineAuthAdapter = {
  engine: 'claude',

  materialize({ homeRoot, key, secret, kind, env }) {
    const dir = atlasEngineHomeDir(homeRoot, 'claude', key);
    const credFile = join(dir, CREDENTIALS_FILENAME);
    if (kind === 'personal') {
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
