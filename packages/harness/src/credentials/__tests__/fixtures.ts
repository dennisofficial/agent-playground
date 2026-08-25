export const FAKE_ACCESS_TOKEN = 'fake-access-token-not-a-real-secret'
export const FAKE_REFRESH_TOKEN = 'fake-refresh-token-not-a-real-secret'

export const FAKE_EXPIRES_AT_EPOCH_MILLIS = 1_800_000_000_000
export const FAKE_EXPIRES_AT_ISO = new Date(FAKE_EXPIRES_AT_EPOCH_MILLIS).toISOString()

export const fakeClaudeCredentialBlob = (
  overrides: { accessToken?: unknown; expiresAt?: unknown } = {},
): string =>
  JSON.stringify({
    claudeAiOauth: {
      accessToken: 'accessToken' in overrides ? overrides.accessToken : FAKE_ACCESS_TOKEN,
      refreshToken: FAKE_REFRESH_TOKEN,
      expiresAt: 'expiresAt' in overrides ? overrides.expiresAt : FAKE_EXPIRES_AT_EPOCH_MILLIS,
      refreshTokenExpiresAt: FAKE_EXPIRES_AT_EPOCH_MILLIS,
      scopes: ['user:inference'],
      subscriptionType: 'fake',
    },
    mcpOAuth: {},
  })
