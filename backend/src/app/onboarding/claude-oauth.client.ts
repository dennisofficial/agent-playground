import { createHash, randomBytes } from 'node:crypto';

/**
 * The Claude subscription OAuth endpoints + client id this host speaks against — verified against the
 * `@anthropic-ai/claude-agent-sdk` bundle (the same constants the CLI's `claude login` uses). Pure,
 * engine-agnostic (no Nest/DI): every function here takes its config explicitly so it's trivially
 * unit-testable and reusable from a non-Nest context.
 */
export type ClaudeOAuthConfig = {
  authorizeUrl: string;
  tokenUrl: string;
  clientId: string;
  redirectUri: string;
  scopes: string;
};

/** The subscription-login (claude.ai) authorize host — the default; console/API OAuth uses a different host. */
const CLAUDE_AI_AUTHORIZE_URL = 'https://claude.com/cai/oauth/authorize';
const TOKEN_URL = 'https://platform.claude.com/v1/oauth/token';
const CLIENT_ID = '9d1c250a-e61b-44d9-88ed-5944d1962f5e';
const SCOPES = 'org:create_api_key user:profile user:inference';

/** Manual (paste-the-code) redirect the CLI uses; hosts that want a real callback override `redirectUri`. */
export const MANUAL_REDIRECT_URL =
  'https://platform.claude.com/oauth/code/callback';

/** The beta header Anthropic's OAuth token endpoint requires. */
const OAUTH_BETA_HEADER = 'oauth-2025-04-20';

/** Bound every OAuth HTTP call the same way `OauthUsageService` bounds its usage probe. */
const FETCH_TIMEOUT_MS = 10_000;

export const DEFAULT_CLAUDE_OAUTH_CONFIG: ClaudeOAuthConfig = {
  authorizeUrl: CLAUDE_AI_AUTHORIZE_URL,
  tokenUrl: TOKEN_URL,
  clientId: CLIENT_ID,
  redirectUri: MANUAL_REDIRECT_URL,
  scopes: SCOPES,
};

/** The env keys this module reads to point at a non-default OAuth deployment (or a test token server). */
export type ClaudeOAuthEnvReader = {
  get(
    key:
      | 'CLAUDE_OAUTH_AUTHORIZE_URL'
      | 'CLAUDE_OAUTH_CLIENT_ID'
      | 'CLAUDE_OAUTH_TOKEN_URL',
  ): string | undefined;
};

/**
 * Resolve the OAuth config from env, overlaying the constant defaults with any deployment overrides
 * (`CLAUDE_OAUTH_{AUTHORIZE_URL,TOKEN_URL,CLIENT_ID}`). The single builder every host-side caller (the
 * controller's authorize/exchange, the usage refresh, the credential-refresh core) resolves through, so a
 * test can retarget `tokenUrl` at a local stub server via one env key.
 */
export function buildClaudeOAuthConfig(env: ClaudeOAuthEnvReader): ClaudeOAuthConfig {
  return {
    ...DEFAULT_CLAUDE_OAUTH_CONFIG,
    authorizeUrl:
      env.get('CLAUDE_OAUTH_AUTHORIZE_URL') ?? DEFAULT_CLAUDE_OAUTH_CONFIG.authorizeUrl,
    tokenUrl: env.get('CLAUDE_OAUTH_TOKEN_URL') ?? DEFAULT_CLAUDE_OAUTH_CONFIG.tokenUrl,
    clientId: env.get('CLAUDE_OAUTH_CLIENT_ID') ?? DEFAULT_CLAUDE_OAUTH_CONFIG.clientId,
  };
}

/**
 * A non-2xx from the token endpoint, carrying the HTTP `status` so callers can distinguish a HARD auth
 * failure (400/401/403 — the refresh token is dead, needs re-login) from a TRANSIENT one (timeout/5xx —
 * retry later). The response body is never included (it may echo secrets).
 */
export class ClaudeOAuthHttpError extends Error {
  constructor(readonly status: number) {
    super(`claude oauth token request failed: HTTP ${status}`);
    this.name = 'ClaudeOAuthHttpError';
  }
}

/** A hard, non-recoverable token failure (the refresh grant was rejected) vs. a transient one worth retrying. */
export function isHardAuthFailure(status: number): boolean {
  return status === 400 || status === 401 || status === 403;
}

/** The resolved token set a successful exchange/refresh yields. `expiresAt` is an absolute epoch MS. */
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
  return buf
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
}

/** Fresh PKCE material for one authorize round-trip: an S256 challenge/verifier pair + a random `state`. */
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

/** Build the `authorizeUrl` the org's owner opens to grant consent. */
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

/**
 * Exchange the pasted authorization code for a token set. The code Anthropic's manual flow displays is
 * `code#state` (state duplicated as a URL fragment) — split on `#` and, when a fragment is present, cross
 * check it against the `state` PKCE was stashed under before trusting the code.
 */
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

/** Refresh an expiring/expired token set using its `refreshToken`. */
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

/** POST one grant to `config.tokenUrl` and parse the response into a `TokenSet` — shared by both grants. */
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
    // Never include the response body (may echo secrets) in the thrown error.
    throw new ClaudeOAuthHttpError(res.status);
  }
  const parsed: unknown = await res.json();
  return parseTokenSet(parsed);
}

/** Defensively parse a token endpoint response into a `TokenSet`; throws when required fields are missing. */
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
    throw new Error(
      'claude oauth token response missing access_token/refresh_token/expires_in',
    );
  }
  const scopes = typeof body.scope === 'string' ? body.scope : undefined;
  const subscriptionType =
    (typeof body.subscription_type === 'string'
      ? body.subscription_type
      : undefined) ??
    (typeof body.account?.subscription_type === 'string'
      ? body.account.subscription_type
      : undefined);
  const accountEmail =
    typeof body.account?.email_address === 'string'
      ? body.account.email_address
      : undefined;
  const organization =
    (typeof body.organization?.name === 'string'
      ? body.organization.name
      : undefined) ??
    (typeof body.organization?.uuid === 'string'
      ? body.organization.uuid
      : undefined);
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
