import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  CodexAuthInvalidError,
  assertValidCodexAuthJson,
  codexAuthHomeDir,
  ensureCodexAuthHome,
  readCodexAuthHome,
} from './codex-auth-home';
import type { EngineHomeKey } from './engine-home';

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

describe('assertValidCodexAuthJson', () => {
  it('accepts a complete ChatGPT-plan auth.json', () => {
    expect(() => assertValidCodexAuthJson(fullTokens)).not.toThrow();
  });

  it('accepts an OPENAI_API_KEY-only blob (no tokens object)', () => {
    expect(() =>
      assertValidCodexAuthJson({ OPENAI_API_KEY: 'sk-live' }),
    ).not.toThrow();
  });

  it('rejects a blob missing id_token — the reported production failure', () => {
    const blob = {
      OPENAI_API_KEY: null,
      tokens: { access_token: 'a', refresh_token: 'r' },
    };
    expect(() => assertValidCodexAuthJson(blob)).toThrow(CodexAuthInvalidError);
    expect(() => assertValidCodexAuthJson(blob)).toThrow(/id_token/);
  });

  it('rejects a tokens object missing refresh_token', () => {
    const blob = { tokens: { id_token: 'i', access_token: 'a' } };
    expect(() => assertValidCodexAuthJson(blob)).toThrow(/refresh_token/);
  });

  it('rejects a non-object / empty blob', () => {
    expect(() => assertValidCodexAuthJson(null)).toThrow(CodexAuthInvalidError);
    expect(() => assertValidCodexAuthJson('nope')).toThrow(
      CodexAuthInvalidError,
    );
  });
});

describe('ensureCodexAuthHome', () => {
  it('throws a clear error on non-JSON (no bare-token wrapping anymore)', () => {
    const root = mkdtempSync(join(tmpdir(), 'codex-home-'));
    expect(() => ensureCodexAuthHome(root, key, 'some-opaque-token')).toThrow(
      CodexAuthInvalidError,
    );
  });

  it('writes auth.json verbatim for a valid blob', () => {
    const root = mkdtempSync(join(tmpdir(), 'codex-home-'));
    const secret = JSON.stringify(fullTokens);
    const home = ensureCodexAuthHome(root, key, secret);
    expect(readFileSync(join(home, 'auth.json'), 'utf8')).toBe(secret);
  });

  it('throws before writing anything when the blob is missing id_token', () => {
    const root = mkdtempSync(join(tmpdir(), 'codex-home-'));
    const secret = JSON.stringify({
      tokens: { access_token: 'a', refresh_token: 'r' },
    });
    expect(() => ensureCodexAuthHome(root, key, secret)).toThrow(/id_token/);
  });
});

describe('codexAuthHomeDir / readCodexAuthHome', () => {
  it('codexAuthHomeDir is deterministic and matches where ensureCodexAuthHome writes', () => {
    const root = mkdtempSync(join(tmpdir(), 'codex-home-'));
    const secret = JSON.stringify(fullTokens);
    const written = ensureCodexAuthHome(root, key, secret);
    expect(codexAuthHomeDir(root, key)).toBe(written);
    expect(codexAuthHomeDir(root, key)).toBe(codexAuthHomeDir(root, key)); // stable
  });

  it('readCodexAuthHome round-trips the written blob', () => {
    const root = mkdtempSync(join(tmpdir(), 'codex-home-'));
    const secret = JSON.stringify(fullTokens);
    ensureCodexAuthHome(root, key, secret);
    expect(readCodexAuthHome(root, key)).toBe(secret);
  });

  it('readCodexAuthHome returns null when no auth.json has been written', () => {
    const root = mkdtempSync(join(tmpdir(), 'codex-home-'));
    expect(
      readCodexAuthHome(root, { ...key, jobId: 'never-written' }),
    ).toBeNull();
  });
});
