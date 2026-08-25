import { describe, expect, it } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { claudeCredentialsFile } from '../../domain/paths.js';
import { EngineHomeService } from '../engine-home.service.js';
import type { ClaudeCredentialBlob } from '../oauth/claude-oauth.client.js';

/**
 * Its own home per case: the service defaults to the real `~/.atlas/claude-home`, and a test that
 * moved `HOME` would still land there — `domain/paths.ts` resolves the home directory at module load.
 */
function home(): { service: EngineHomeService; dir: string; file: string; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), 'atlas-home-'));
  return {
    service: new EngineHomeService(dir),
    dir,
    file: claudeCredentialsFile(dir),
    cleanup: () => rmSync(dir, { recursive: true, force: true }),
  };
}

function blob(over: { accessToken?: string; refreshToken?: string } = {}): ClaudeCredentialBlob {
  return {
    claudeAiOauth: {
      accessToken: over.accessToken ?? 'oat-1',
      refreshToken: over.refreshToken ?? 'ort-1',
      expiresAt: 1_000,
      scopes: ['user:inference'],
    },
  };
}

describe('EngineHomeService.prepareClaudeHome', () => {
  it('writes the credential the engine will read, and points the engine at that home', () => {
    const { service, dir, file, cleanup } = home();

    const env = service.prepareClaudeHome({ accountId: 'account-1', blob: blob() });

    expect(env.CLAUDE_CONFIG_DIR).toBe(dir);
    expect(env.CLAUDE_CODE_OAUTH_TOKEN).toBe('oat-1');
    expect(JSON.parse(readFileSync(file, 'utf8'))).toEqual(blob());
    cleanup();
  });
});

/**
 * The read-back. The engine refreshes the credentials file in place when the access token is close to
 * expiry, and the server rotates the refresh token as it does — so after a turn, the file may hold
 * the only valid pair left. Whether it is OURS is the part this method answers.
 */
describe('EngineHomeService.observeClaudeCredential', () => {
  it('reports what the engine left in the file', () => {
    const { service, file, cleanup } = home();
    service.prepareClaudeHome({ accountId: 'account-1', blob: blob() });

    writeFileSync(file, JSON.stringify(blob({ accessToken: 'oat-2', refreshToken: 'ort-2' })));

    expect(service.observeClaudeCredential('account-1')).toEqual(
      blob({ accessToken: 'oat-2', refreshToken: 'ort-2' }),
    );
    cleanup();
  });

  /**
   * One home per engine, shared by every account of that engine. If the last turn to write the file
   * was another account's, whatever is in it now says nothing about this one — and adopting it would
   * file a credential under the wrong email.
   */
  it('refuses to attribute the file to an account that did not write it last', () => {
    const { service, cleanup } = home();
    service.prepareClaudeHome({ accountId: 'account-1', blob: blob() });
    service.prepareClaudeHome({ accountId: 'account-2', blob: blob({ accessToken: 'oat-b' }) });

    expect(service.observeClaudeCredential('account-1')).toBeNull();
    expect(service.observeClaudeCredential('account-2')).not.toBeNull();
    cleanup();
  });

  it('reports nothing when this process never wrote the file', () => {
    // A fresh instance has no claim on a file some earlier run left behind.
    const { service, file, cleanup } = home();
    writeFileSync(file, JSON.stringify(blob()));

    expect(service.observeClaudeCredential('account-1')).toBeNull();
    cleanup();
  });

  it('survives a missing or unparseable file rather than failing a turn on its way out', () => {
    const { service, file, cleanup } = home();
    service.prepareClaudeHome({ accountId: 'account-1', blob: blob() });

    writeFileSync(file, '{ truncated');

    expect(service.observeClaudeCredential('account-1')).toBeNull();
    rmSync(file);
    expect(service.observeClaudeCredential('account-1')).toBeNull();
    cleanup();
  });

  it('survives a file whose shape is not a credential blob', () => {
    const { service, file, cleanup } = home();
    service.prepareClaudeHome({ accountId: 'account-1', blob: blob() });

    writeFileSync(file, JSON.stringify({ somethingElse: true }));

    expect(service.observeClaudeCredential('account-1')).toBeNull();
    cleanup();
  });
});

describe('EngineHomeService.claim', () => {
  it('hands the spawning turn the credential it asked for, and claims the file for that account', async () => {
    const { service, file, cleanup } = home();
    const read = (): string =>
      (JSON.parse(readFileSync(file, 'utf8')) as ClaudeCredentialBlob).claudeAiOauth.accessToken;

    const seen = await service.claim(
      { accountId: 'account-1', blob: blob({ accessToken: 'oat-a' }) },
      (env) => ({ env: env.CLAUDE_CODE_OAUTH_TOKEN, onDisk: read() }),
    );

    expect(seen).toEqual({ env: 'oat-a', onDisk: 'oat-a' });
    // Claiming is what makes the read-back attributable — the runner reads it back through this id.
    expect(service.observeClaudeCredential('account-1')).not.toBeNull();
    cleanup();
  });
});
