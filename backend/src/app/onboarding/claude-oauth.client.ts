import { createHash, randomBytes } from 'node:crypto';

export type ClaudeOAuthConfig = {
  authorizeUrl: string;
  tokenUrl: string;
  clientId: string;
  redirectUri: string;
  scopes: string;
};

const CLAUDE_AI_AUTHORIZE_URL = 'https://claude.com/cai/oauth/authorize';
const TOKEN_URL = 'https://platform.claude.com/v1/oauth/token';
const CLIENT_ID = '9d1c250a-e61b-44d9-88ed-5944d1962f5e';
const SCOPES = 'org:create_api_key user:profile user:inference';

export const MANUAL_REDIRECT_URL = 'https://platform.claude.com/oauth/code/callback';

const OAUTH_BETA_HEADER = 'oauth-2025-04-20';

const FETCH_TIMEOUT_MS = 10_000;

export const DEFAULT_CLAUDE_OAUTH_CONFIG: ClaudeOAuthConfig = {
  authorizeUrl: CLAUDE_AI_AUTHORIZE_URL,
  tokenUrl: TOKEN_URL,
  clientId: CLIENT_ID,
  redirectUri: MANUAL_REDIRECT_URL,
  scopes: SCOPES,
};

export type ClaudeOAuthEnvReader = {
  get(
    key: 'CLAUDE_OAUTH_AUTHORIZE_URL' | 'CLAUDE_OAUTH_CLIENT_ID' | 'CLAUDE_OAUTH_TOKEN_URL',
  ): string | undefined;
};

export function buildClaudeOAuthConfig(env: ClaudeOAuthEnvReader): ClaudeOAuthConfig {
  return {
    ...DEFAULT_CLAUDE_OAUTH_CONFIG,
    authorizeUrl: env.get('CLAUDE_OAUTH_AUTHORIZE_URL') ?? DEFAULT_CLAUDE_OAUTH_CONFIG.authorizeUrl,
    tokenUrl: env.get('CLAUDE_OAUTH_TOKEN_URL') ?? DEFAULT_CLAUDE_OAUTH_CONFIG.tokenUrl,
    clientId: env.get('CLAUDE_OAUTH_CLIENT_ID') ?? DEFAULT_CLAUDE_OAUTH_CONFIG.clientId,
  };
}

export class ClaudeOAuthHttpError extends Error {
  constructor(readonly status: number) {
    super(`claude oauth token request failed: HTTP ${status}`);
    this.name = 'ClaudeOAuthHttpError';
  }
}

export function isHardAuthFailure(status: number): boolean {
  return status === 400 || status === 401 || status === 403;
}

export type TokenSet = {
  accessToken: string;
  refreshToken: string;
  expiresAt: number;
  scopes?: string;
  subscriptionType?: string;
  accountEmail?: string;
  organization?: string;
};

function base64url(buf: Buffer): string {
  return buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export function generatePkce(): {
  verifier: string;
  challenge: string;
  state: string;
} {
  const verifier = base64url(randomBytes(32));
  const challenge = base64url(createHash('sha256').update(verifier).digest());
  const state = base64url(randomBytes(32));
  return { verifier, challenge, state };
}

export function buildAuthorizeUrl(
  config: ClaudeOAuthConfig,
  pkce: { challenge: string; state: string },
): string {
  const url = new URL(config.authorizeUrl);
  url.searchParams.set('client_id', config.clientId);
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('redirect_uri', config.redirectUri);
  url.searchParams.set('scope', config.scopes);
  url.searchParams.set('code_challenge', pkce.challenge);
  url.searchParams.set('code_challenge_method', 'S256');
  url.searchParams.set('state', pkce.state);
  url.searchParams.set('code', 'true');
  return url.toString();
}

export async function exchangeCode(
  config: ClaudeOAuthConfig,
  input: { code: string; verifier: string; state: string },
): Promise<TokenSet> {
  const [bareCode, fragmentState] = input.code.split('#');
  if (fragmentState !== undefined && fragmentState !== input.state) {
    throw new Error('claude oauth: state mismatch in pasted code');
  }
  return postForTokenSet(config, {
    grant_type: 'authorization_code',
    code: bareCode,
    state: input.state,
    redirect_uri: config.redirectUri,
    client_id: config.clientId,
    code_verifier: input.verifier,
  });
}

export async function refresh(
  config: ClaudeOAuthConfig,
  input: { refreshToken: string },
): Promise<TokenSet> {
  return postForTokenSet(config, {
    grant_type: 'refresh_token',
    refresh_token: input.refreshToken,
    client_id: config.clientId,
  });
}

async function postForTokenSet(
  config: ClaudeOAuthConfig,
  body: Record<string, string>,
): Promise<TokenSet> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  let res: Response;
  try {
    res = await fetch(config.tokenUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'anthropic-beta': OAUTH_BETA_HEADER,
      },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
  } finally {
    clearTimeout(timeout);
  }
  if (!res.ok) {
    throw new ClaudeOAuthHttpError(res.status);
  }
  const parsed: unknown = await res.json();
  return parseTokenSet(parsed);
}

function parseTokenSet(raw: unknown): TokenSet {
  const body = (raw ?? {}) as {
    access_token?: unknown;
    refresh_token?: unknown;
    expires_in?: unknown;
    scope?: unknown;
    subscription_type?: unknown;
    account?: { subscription_type?: unknown; email_address?: unknown };
    organization?: { name?: unknown; uuid?: unknown };
  };
  const accessToken = body.access_token;
  const refreshToken = body.refresh_token;
  const expiresIn = body.expires_in;
  if (
    typeof accessToken !== 'string' ||
    typeof refreshToken !== 'string' ||
    typeof expiresIn !== 'number'
  ) {
    throw new Error('claude oauth token response missing access_token/refresh_token/expires_in');
  }
  const scopes = typeof body.scope === 'string' ? body.scope : undefined;
  const subscriptionType =
    (typeof body.subscription_type === 'string' ? body.subscription_type : undefined) ??
    (typeof body.account?.subscription_type === 'string'
      ? body.account.subscription_type
      : undefined);
  const accountEmail =
    typeof body.account?.email_address === 'string' ? body.account.email_address : undefined;
  const organization =
    (typeof body.organization?.name === 'string' ? body.organization.name : undefined) ??
    (typeof body.organization?.uuid === 'string' ? body.organization.uuid : undefined);
  return {
    accessToken,
    refreshToken,
    expiresAt: Date.now() + expiresIn * 1000,
    scopes,
    subscriptionType,
    accountEmail,
    organization,
  };
}
