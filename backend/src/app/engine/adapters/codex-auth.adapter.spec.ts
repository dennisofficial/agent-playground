import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { codexAuthHomeDir } from '../codex-auth-home';
import type { EngineHomeKey } from '../engine-home';
import { codexAuthAdapter } from './codex-auth.adapter';

const key: EngineHomeKey = {
  orgId: 'org',
  repoId: 'repo',
  jobId: 'job',
  type: 'plan-review',
};

const fullTokens = {
  OPENAI_API_KEY: null,
  tokens: {
    id_token: 'eyJ.id',
    access_token: 'eyJ.acc',
    refresh_token: 'rt',
    account_id: 'a',
  },
  last_refresh: '2026-07-03T00:00:00.000Z',
};

describe('codexAuthAdapter.materialize', () => {
  it('writes auth.json verbatim for a valid blob (round-trip)', () => {
    const root = mkdtempSync(join(tmpdir(), 'codex-adapter-'));
    const secret = JSON.stringify(fullTokens);
    const env: Record<string, string | undefined> = {};

    const home = codexAuthAdapter.materialize({
      homeRoot: root,
      key,
      secret,
      env,
    });

    expect(readFileSync(join(home, 'auth.json'), 'utf8')).toBe(secret);
    expect(home).toBe(codexAuthHomeDir(root, key));
  });

  it('throws on invalid JSON', () => {
    const root = mkdtempSync(join(tmpdir(), 'codex-adapter-'));
    expect(() =>
      codexAuthAdapter.materialize({
        homeRoot: root,
        key,
        secret: 'not-json',
        env: {},
      }),
    ).toThrow();
  });
});

describe('codexAuthAdapter.readBackRefresh', () => {
  it('detects a change (refresh) and returns the rotated blob', () => {
    const root = mkdtempSync(join(tmpdir(), 'codex-adapter-'));
    const written = JSON.stringify(fullTokens);
    codexAuthAdapter.materialize({
      homeRoot: root,
      key,
      secret: written,
      env: {},
    });

    const rotated = JSON.stringify({
      ...fullTokens,
      last_refresh: '2026-07-04T00:00:00.000Z',
    });
    codexAuthAdapter.materialize({
      homeRoot: root,
      key,
      secret: rotated,
      env: {},
    });

    expect(
      codexAuthAdapter.readBackRefresh({
        homeRoot: root,
        key,
        writtenSecret: written,
      }),
    ).toBe(rotated);
  });

  it('returns undefined when unchanged', () => {
    const root = mkdtempSync(join(tmpdir(), 'codex-adapter-'));
    const written = JSON.stringify(fullTokens);
    codexAuthAdapter.materialize({
      homeRoot: root,
      key,
      secret: written,
      env: {},
    });

    expect(
      codexAuthAdapter.readBackRefresh({
        homeRoot: root,
        key,
        writtenSecret: written,
      }),
    ).toBeUndefined();
  });

  it('returns undefined when the file is absent', () => {
    const root = mkdtempSync(join(tmpdir(), 'codex-adapter-'));
    expect(
      codexAuthAdapter.readBackRefresh({
        homeRoot: root,
        key: { ...key, jobId: 'never-written' },
        writtenSecret: 'x',
      }),
    ).toBeUndefined();
  });
});
