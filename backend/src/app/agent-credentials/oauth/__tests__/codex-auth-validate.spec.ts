import { assertValidCodexAuthJson, CodexAuthInvalidError } from '../codex-auth-validate';

describe('assertValidCodexAuthJson', () => {
  it('accepts a full tokens object', () => {
    expect(() =>
      assertValidCodexAuthJson({
        tokens: { id_token: 'a', access_token: 'b', refresh_token: 'c' },
      }),
    ).not.toThrow();
  });

  it('accepts an OPENAI_API_KEY-only blob', () => {
    expect(() => assertValidCodexAuthJson({ OPENAI_API_KEY: 'sk-x' })).not.toThrow();
  });

  it('rejects a non-object', () => {
    expect(() => assertValidCodexAuthJson('nope')).toThrow(CodexAuthInvalidError);
  });

  it('rejects tokens missing a required field', () => {
    expect(() =>
      assertValidCodexAuthJson({ tokens: { id_token: 'a', access_token: 'b' } }),
    ).toThrow(/refresh_token/);
  });

  it('rejects when neither api key nor tokens present', () => {
    expect(() => assertValidCodexAuthJson({})).toThrow(CodexAuthInvalidError);
  });
});
