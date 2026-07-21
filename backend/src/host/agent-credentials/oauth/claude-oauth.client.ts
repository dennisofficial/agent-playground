import { Injectable } from '@nestjs/common';
import axios from 'axios';
import { createHash, randomBytes } from 'node:crypto';

/**
 * Claude.ai subscription OAuth — Authorization Code + PKCE (S256), manual paste-the-code (same flow the
 * Claude Code CLI uses). Anthropic hosts a callback page that just displays `code#state` for the user to
 * paste back; there is no server-side redirect. Constants are public → code, not env.
 */
const AUTHORIZE_URL = 'https://claude.com/cai/oauth/authorize';
const TOKEN_URL = 'https://platform.claude.com/v1/oauth/token';
const CLIENT_ID = '9d1c250a-e61b-44d9-88ed-5944d1962f5e';
const SCOPES = 'org:create_api_key user:profile user:inference';
const MANUAL_REDIRECT_URL = 'https://platform.claude.com/oauth/code/callback';
const OAUTH_BETA_HEADER = 'oauth-2025-04-20';
const FETCH_TIMEOUT_MS = 10_000;

export class ClaudeOAuthHttpError extends Error {
  constructor(readonly status: number) {
    super(`claude oauth token request failed: HTTP ${status}`);
    this.name = 'ClaudeOAuthHttpError';
  }
}

export type ClaudeTokenSet = {
  accessToken: string;
  refreshToken: string;
  expiresAt: number; // epoch ms
  scopes?: string;
  subscriptionType?: string;
  accountEmail?: string;
  organization?: string;
};

export type ClaudeCredentialBlob = {
  claudeAiOauth: {
    accessToken: string;
    refreshToken: string;
    expiresAt: number;
    scopes: string[];
    subscriptionType?: string;
  };
};

@Injectable()
export class ClaudeOAuthClient {
  isHardAuthFailure(status: number): boolean {
    return status === 400 || status === 401 || status === 403;
  }

  generatePkce(): { verifier: string; challenge: string; state: string } {
    const verifier = this.base64url(randomBytes(32));
    const challenge = this.base64url(createHash('sha256').update(verifier).digest());
    const state = this.base64url(randomBytes(32));
    return { verifier, challenge, state };
  }

  buildAuthorizeUrl(pkce: { challenge: string; state: string }): string {
    const url = new URL(AUTHORIZE_URL);
    url.searchParams.set('client_id', CLIENT_ID);
    url.searchParams.set('response_type', 'code');
    url.searchParams.set('redirect_uri', MANUAL_REDIRECT_URL);
    url.searchParams.set('scope', SCOPES);
    url.searchParams.set('code_challenge', pkce.challenge);
    url.searchParams.set('code_challenge_method', 'S256');
    url.searchParams.set('state', pkce.state);
    url.searchParams.set('code', 'true'); // manual-code mode
    return url.toString();
  }

  async exchangeCode(input: {
    code: string;
    verifier: string;
    state: string;
  }): Promise<ClaudeTokenSet> {
    const [bareCode, fragmentState] = input.code.split('#');
    if (fragmentState !== undefined && fragmentState !== input.state) {
      throw new Error('claude oauth: state mismatch in pasted code');
    }
    return this.postForTokenSet({
      grant_type: 'authorization_code',
      code: bareCode,
      state: input.state,
      redirect_uri: MANUAL_REDIRECT_URL,
      client_id: CLIENT_ID,
      code_verifier: input.verifier,
    });
  }

  async refresh(refreshToken: string): Promise<ClaudeTokenSet> {
    return this.postForTokenSet({
      grant_type: 'refresh_token',
      refresh_token: refreshToken,
      client_id: CLIENT_ID,
    });
  }

  tokenSetToBlob(t: ClaudeTokenSet): ClaudeCredentialBlob {
    return {
      claudeAiOauth: {
        accessToken: t.accessToken,
        refreshToken: t.refreshToken,
        expiresAt: t.expiresAt,
        scopes: t.scopes ? t.scopes.split(/\s+/).filter(Boolean) : [],
        subscriptionType: t.subscriptionType,
      },
    };
  }

  parseTokenSet(raw: unknown): ClaudeTokenSet {
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

  private base64url(buf: Buffer): string {
    return buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  }

  private async postForTokenSet(body: Record<string, string>): Promise<ClaudeTokenSet> {
    const res = await axios.post(TOKEN_URL, body, {
      headers: { 'Content-Type': 'application/json', 'anthropic-beta': OAUTH_BETA_HEADER },
      timeout: FETCH_TIMEOUT_MS,
      validateStatus: () => true,
    });
    if (res.status < 200 || res.status >= 300) throw new ClaudeOAuthHttpError(res.status);
    return this.parseTokenSet(res.data);
  }
}
