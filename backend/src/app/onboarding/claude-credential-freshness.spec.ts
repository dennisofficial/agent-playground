import { describe, expect, it } from 'vitest';
import { isNewerClaudeCredential, parseClaudeExpiresAt } from './claude-credential-freshness';

function claudeBlob(expiresAt: number, tag = 'x'): string {
  return JSON.stringify({ claudeAiOauth: { expiresAt, accessToken: tag } });
}

describe('parseClaudeExpiresAt', () => {
  it('reads claudeAiOauth.expiresAt', () => {
    expect(parseClaudeExpiresAt(claudeBlob(1000))).toBe(1000);
  });

  it('returns null for malformed JSON', () => {
    expect(parseClaudeExpiresAt('not json')).toBeNull();
  });

  it('returns null when claudeAiOauth or expiresAt is missing', () => {
    expect(parseClaudeExpiresAt(JSON.stringify({}))).toBeNull();
    expect(parseClaudeExpiresAt(JSON.stringify({ claudeAiOauth: {} }))).toBeNull();
  });

  it('returns null when expiresAt is not a finite number', () => {
    expect(parseClaudeExpiresAt(JSON.stringify({ claudeAiOauth: { expiresAt: 'soon' } }))).toBeNull();
    expect(parseClaudeExpiresAt(JSON.stringify({ claudeAiOauth: { expiresAt: NaN } }))).toBeNull();
  });
});

describe('isNewerClaudeCredential', () => {
  it('a NEWER expiresAt wins', () => {
    expect(isNewerClaudeCredential(claudeBlob(2000, 'next'), claudeBlob(1000, 'current'))).toBe(true);
  });

  it('an OLDER expiresAt loses', () => {
    expect(isNewerClaudeCredential(claudeBlob(1000, 'next'), claudeBlob(2000, 'current'))).toBe(false);
  });

  it('an EQUAL expiresAt loses', () => {
    expect(isNewerClaudeCredential(claudeBlob(1000, 'next'), claudeBlob(1000, 'current'))).toBe(false);
  });

  it('falls back to "changed at all" when either side is unparseable', () => {
    const current = claudeBlob(1000, 'current');
    expect(isNewerClaudeCredential('not json', current)).toBe(true);
    expect(isNewerClaudeCredential(current, current)).toBe(false);
  });
});
