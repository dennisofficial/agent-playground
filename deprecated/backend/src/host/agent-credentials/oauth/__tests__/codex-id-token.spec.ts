import { CodexAuthService } from '../codex-auth.service';

const codexAuth = new CodexAuthService();
const decodeCodexAccountEmail = (authJson: string) => codexAuth.decodeAccountEmail(authJson);
const decodeCodexIdentity = (idToken: string) => codexAuth.decodeIdentity(idToken);
const decodeJwtExpMs = (jwt: string | undefined) => codexAuth.decodeJwtExpMs(jwt);

function jwt(payload: Record<string, unknown>): string {
  const b = (o: unknown): string => Buffer.from(JSON.stringify(o)).toString('base64url');
  return `${b({ alg: 'none' })}.${b(payload)}.sig`;
}

describe('decodeCodexAccountEmail', () => {
  it('reads the top-level email claim from the id_token', () => {
    const authJson = JSON.stringify({ tokens: { id_token: jwt({ email: 'a@b.com' }) } });
    expect(decodeCodexAccountEmail(authJson)).toBe('a@b.com');
  });
  it('falls back to the OpenAI profile namespace', () => {
    const authJson = JSON.stringify({
      tokens: { id_token: jwt({ 'https://api.openai.com/profile': { email: 'c@d.com' } }) },
    });
    expect(decodeCodexAccountEmail(authJson)).toBe('c@d.com');
  });
  it('returns undefined for an api-key-only blob', () => {
    expect(decodeCodexAccountEmail(JSON.stringify({ OPENAI_API_KEY: 'sk-x' }))).toBeUndefined();
  });
});

describe('decodeCodexIdentity', () => {
  it('extracts account id + plan from the auth claims namespace', () => {
    const token = jwt({
      email: 'e@f.com',
      'https://api.openai.com/auth': { chatgpt_account_id: 'acc_123', chatgpt_plan_type: 'plus' },
    });
    expect(decodeCodexIdentity(token)).toEqual({
      email: 'e@f.com',
      accountId: 'acc_123',
      planType: 'plus',
    });
  });
});

describe('decodeJwtExpMs', () => {
  it('converts the exp claim (seconds) to ms', () => {
    expect(decodeJwtExpMs(jwt({ exp: 1_700_000_000 }))).toBe(1_700_000_000_000);
  });
  it('returns null when exp is absent', () => {
    expect(decodeJwtExpMs(jwt({}))).toBeNull();
    expect(decodeJwtExpMs(undefined)).toBeNull();
  });
});
