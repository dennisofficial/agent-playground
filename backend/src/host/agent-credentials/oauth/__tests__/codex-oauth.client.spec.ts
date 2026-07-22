import axios from 'axios';
import { CodexAuthService } from '../codex-auth.service';
import { CodexOAuthClient, CodexOAuthHttpError } from '../codex-oauth.client';

vi.mock('axios');

const client = new CodexOAuthClient(new CodexAuthService());

function jwt(payload: Record<string, unknown>): string {
  const b = (o: unknown): string => Buffer.from(JSON.stringify(o)).toString('base64url');
  return `${b({ alg: 'none' })}.${b(payload)}.sig`;
}

function mockPost(status: number, body: unknown): void {
  vi.mocked(axios.post).mockResolvedValue({ status, data: body });
}

afterEach(() => vi.clearAllMocks());

describe('startDeviceAuth', () => {
  it('returns the device code + a client-constructed verification URL', async () => {
    mockPost(200, { device_auth_id: 'dev_1', user_code: 'WXYZ-1234', interval: '0' });
    const res = await client.startDeviceAuth();
    expect(res.deviceAuthId).toBe('dev_1');
    expect(res.userCode).toBe('WXYZ-1234');
    expect(res.intervalSec).toBe(0);
    expect(res.verificationUri).toBe('https://auth.openai.com/codex/device');
    expect(res.expiresIn).toBe(15 * 60);
  });

  it('explains when device login is not enabled (404)', async () => {
    mockPost(404, {});
    await expect(client.startDeviceAuth()).rejects.toThrow(/not enabled/i);
  });
});

describe('pollDeviceOnce', () => {
  const input = { deviceAuthId: 'dev_1', userCode: 'WXYZ-1234' };

  it('treats 403 as still pending', async () => {
    mockPost(403, {});
    expect(await client.pollDeviceOnce(input)).toEqual({ pending: true });
  });

  it('returns the authorization code + verifier on success', async () => {
    mockPost(200, { authorization_code: 'ac', code_challenge: 'cc', code_verifier: 'cv' });
    expect(await client.pollDeviceOnce(input)).toEqual({
      pending: false,
      authorizationCode: 'ac',
      codeVerifier: 'cv',
    });
  });

  it('throws on an unexpected status', async () => {
    mockPost(500, {});
    await expect(client.pollDeviceOnce(input)).rejects.toBeInstanceOf(CodexOAuthHttpError);
  });
});

describe('buildAuthJson', () => {
  it('assembles the auth.json shape with account_id from the id_token', () => {
    const idToken = jwt({ 'https://api.openai.com/auth': { chatgpt_account_id: 'acc_9' } });
    const now = '2026-07-18T00:00:00.000Z';
    const parsed = JSON.parse(
      client.buildAuthJson({ idToken, accessToken: 'at', refreshToken: 'rt' }, now),
    );
    expect(parsed.OPENAI_API_KEY).toBeNull();
    expect(parsed.tokens).toEqual({
      id_token: idToken,
      access_token: 'at',
      refresh_token: 'rt',
      account_id: 'acc_9',
    });
    expect(parsed.last_refresh).toBe(now);
    expect(parsed.auth_mode).toBe('chatgpt');
  });
});
