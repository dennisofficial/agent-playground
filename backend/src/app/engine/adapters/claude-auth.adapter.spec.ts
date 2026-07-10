import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { atlasEngineHomeDir, type EngineHomeKey } from '../engine-home';
import { claudeAuthAdapter } from './claude-auth.adapter';

const key: EngineHomeKey = { orgId: 'org', repoId: 'repo', jobId: 'job', type: 'build' };

function oauthBlob(expiresAt: number, accessToken = 'access'): string {
  return JSON.stringify({
    claudeAiOauth: { accessToken, refreshToken: 'refresh', expiresAt, scopes: ['user:inference'] },
  });
}

describe('claudeAuthAdapter.materialize', () => {
  it('personal: writes .credentials.json and does NOT set the env token (env token outranks the file)', () => {
    const root = mkdtempSync(join(tmpdir(), 'claude-auth-'));
    const secret = oauthBlob(1_000_000);
    const env: Record<string, string | undefined> = { ANTHROPIC_API_KEY: 'sk-stale' };

    const dir = claudeAuthAdapter.materialize({ homeRoot: root, key, secret, kind: 'personal', env });

    expect(readFileSync(join(dir, '.credentials.json'), 'utf8')).toBe(secret);
    expect(env.CLAUDE_CODE_OAUTH_TOKEN).toBeUndefined();
    expect(env.ANTHROPIC_API_KEY).toBeUndefined();
    expect(env.ANTHROPIC_AUTH_TOKEN).toBeUndefined();
  });

  it('setup-token: sets CLAUDE_CODE_OAUTH_TOKEN, strips API keys, and removes a stale personal file', () => {
    const root = mkdtempSync(join(tmpdir(), 'claude-auth-'));
    const dir = atlasEngineHomeDir(root, 'claude', key);
    writeFileSync(join(dir, '.credentials.json'), oauthBlob(1), { mode: 0o600 });
    const env: Record<string, string | undefined> = { ANTHROPIC_API_KEY: 'sk-stale', ANTHROPIC_AUTH_TOKEN: 'stale' };

    claudeAuthAdapter.materialize({ homeRoot: root, key, secret: 'a-setup-token', kind: 'setup-token', env });

    expect(env.CLAUDE_CODE_OAUTH_TOKEN).toBe('a-setup-token');
    expect(env.ANTHROPIC_API_KEY).toBeUndefined();
    expect(env.ANTHROPIC_AUTH_TOKEN).toBeUndefined();
    expect(existsSync(join(dir, '.credentials.json'))).toBe(false);
  });

  it('legacy (no kind): behaves like setup-token', () => {
    const root = mkdtempSync(join(tmpdir(), 'claude-auth-'));
    const env: Record<string, string | undefined> = {};

    claudeAuthAdapter.materialize({ homeRoot: root, key, secret: 'legacy-token', env });

    expect(env.CLAUDE_CODE_OAUTH_TOKEN).toBe('legacy-token');
  });
});

describe('claudeAuthAdapter.readBackRefresh', () => {
  it('returns the rotated blob when the file was rewritten with a newer expiresAt', () => {
    const root = mkdtempSync(join(tmpdir(), 'claude-auth-'));
    const written = oauthBlob(1_000_000);
    const env: Record<string, string | undefined> = {};
    claudeAuthAdapter.materialize({ homeRoot: root, key, secret: written, kind: 'personal', env });

    const dir = atlasEngineHomeDir(root, 'claude', key);
    const rotated = oauthBlob(2_000_000);
    writeFileSync(join(dir, '.credentials.json'), rotated, { mode: 0o600 });

    expect(claudeAuthAdapter.readBackRefresh({ homeRoot: root, key, writtenSecret: written })).toBe(rotated);
  });

  it('returns undefined when the file is unchanged (same bytes)', () => {
    const root = mkdtempSync(join(tmpdir(), 'claude-auth-'));
    const written = oauthBlob(1_000_000);
    const env: Record<string, string | undefined> = {};
    claudeAuthAdapter.materialize({ homeRoot: root, key, secret: written, kind: 'personal', env });

    expect(claudeAuthAdapter.readBackRefresh({ homeRoot: root, key, writtenSecret: written })).toBeUndefined();
  });

  it('returns undefined when the file is absent', () => {
    const root = mkdtempSync(join(tmpdir(), 'claude-auth-'));
    expect(
      claudeAuthAdapter.readBackRefresh({ homeRoot: root, key: { ...key, jobId: 'never-written' }, writtenSecret: 'x' }),
    ).toBeUndefined();
  });
});

describe('claudeAuthAdapter.validate', () => {
  it('throws on a blob missing claudeAiOauth.accessToken', () => {
    expect(() => claudeAuthAdapter.validate(JSON.stringify({ claudeAiOauth: { refreshToken: 'r' } }))).toThrow(
      /accessToken/,
    );
  });

  it('accepts a well-formed blob', () => {
    expect(() => claudeAuthAdapter.validate(oauthBlob(1))).not.toThrow();
  });
});
