import { Injectable } from '@nestjs/common';
import axios, { type AxiosResponse } from 'axios';
import { decodeCodexIdentity } from './codex-id-token.util';

/**
 * ChatGPT/Codex subscription login via OpenAI's device-code flow — the same one `codex login --device-auth`
 * uses. NOTE: this is a BESPOKE OpenAI flow, not RFC 8628. Shape (verified against openai/codex
 * `codex-rs/login`):
 *   1. POST /api/accounts/deviceauth/usercode {client_id} → {device_auth_id, user_code, interval}
 *   2. poll POST /api/accounts/deviceauth/token {device_auth_id, user_code}: HTTP 403/404 = still pending;
 *      HTTP 200 = {authorization_code, code_challenge, code_verifier} (server-generated PKCE)
 *   3. exchange POST /oauth/token (form) grant_type=authorization_code → {id_token, access_token, refresh_token}
 * The verification URL and 15-minute expiry are client-constructed (the server returns neither).
 * Constants are public → code, not env.
 */
const CLIENT_ID = 'app_EMoamEEZ73f0CkXaXp7hrann';
const USERCODE_URL = 'https://auth.openai.com/api/accounts/deviceauth/usercode';
const DEVICE_TOKEN_URL = 'https://auth.openai.com/api/accounts/deviceauth/token';
const OAUTH_TOKEN_URL = 'https://auth.openai.com/oauth/token';
const DEVICE_REDIRECT_URI = 'https://auth.openai.com/deviceauth/callback';
const VERIFICATION_URL = 'https://auth.openai.com/codex/device';
const DEVICE_EXPIRES_IN_SEC = 15 * 60; // client-side cap; the server doesn't return an expiry
const FETCH_TIMEOUT_MS = 10_000;

export class CodexOAuthHttpError extends Error {
  constructor(readonly status: number) {
    super(`codex oauth request failed: HTTP ${status}`);
    this.name = 'CodexOAuthHttpError';
  }
}

export type CodexDeviceAuth = {
  deviceAuthId: string;
  userCode: string;
  /** Seconds between polls (server may report 0). */
  intervalSec: number;
  verificationUri: string;
  expiresIn: number;
};

export type CodexTokens = { idToken: string; accessToken: string; refreshToken: string };

export type CodexPollResult =
  | { pending: true }
  | { pending: false; authorizationCode: string; codeVerifier: string };

@Injectable()
export class CodexOAuthClient {
  isHardAuthFailure(status: number): boolean {
    return status === 400 || status === 401 || status === 403;
  }

  async startDeviceAuth(): Promise<CodexDeviceAuth> {
    const res = await this.timedPost(
      USERCODE_URL,
      { client_id: CLIENT_ID },
      { 'Content-Type': 'application/json' },
    );
    if (res.status === 404) {
      throw new Error(
        'Codex device-code login is not enabled for this account. Enable "Sign in with device code" in your ChatGPT security settings, or paste your ~/.codex/auth.json instead.',
      );
    }
    if (res.status < 200 || res.status >= 300) throw new CodexOAuthHttpError(res.status);
    const body = res.data as {
      device_auth_id?: unknown;
      user_code?: unknown;
      usercode?: unknown;
      interval?: unknown;
    };
    const deviceAuthId = body.device_auth_id;
    const userCode = body.user_code ?? body.usercode;
    if (typeof deviceAuthId !== 'string' || typeof userCode !== 'string') {
      throw new Error('codex device auth response missing device_auth_id/user_code');
    }
    // interval may arrive as a string ("0") or number.
    const intervalRaw = typeof body.interval === 'string' ? Number(body.interval) : body.interval;
    const intervalSec = Number.isFinite(intervalRaw) ? Number(intervalRaw) : 5;
    return {
      deviceAuthId,
      userCode,
      intervalSec,
      verificationUri: VERIFICATION_URL,
      expiresIn: DEVICE_EXPIRES_IN_SEC,
    };
  }

  async pollDeviceOnce(input: {
    deviceAuthId: string;
    userCode: string;
  }): Promise<CodexPollResult> {
    const res = await this.timedPost(
      DEVICE_TOKEN_URL,
      { device_auth_id: input.deviceAuthId, user_code: input.userCode },
      { 'Content-Type': 'application/json' },
    );
    if (res.status === 403 || res.status === 404) return { pending: true };
    if (res.status < 200 || res.status >= 300) throw new CodexOAuthHttpError(res.status);
    const body = res.data as { authorization_code?: unknown; code_verifier?: unknown };
    if (typeof body.authorization_code !== 'string' || typeof body.code_verifier !== 'string') {
      throw new Error('codex device token response missing authorization_code/code_verifier');
    }
    return {
      pending: false,
      authorizationCode: body.authorization_code,
      codeVerifier: body.code_verifier,
    };
  }

  async exchangeDeviceCode(input: {
    authorizationCode: string;
    codeVerifier: string;
  }): Promise<CodexTokens> {
    const form = new URLSearchParams({
      grant_type: 'authorization_code',
      code: input.authorizationCode,
      redirect_uri: DEVICE_REDIRECT_URI,
      client_id: CLIENT_ID,
      code_verifier: input.codeVerifier,
    });
    const res = await this.timedPost(OAUTH_TOKEN_URL, form.toString(), {
      'Content-Type': 'application/x-www-form-urlencoded',
    });
    if (res.status < 200 || res.status >= 300) throw new CodexOAuthHttpError(res.status);
    return this.parseTokens(res.data);
  }

  async refresh(refreshToken: string): Promise<Partial<CodexTokens>> {
    const res = await this.timedPost(
      OAUTH_TOKEN_URL,
      { client_id: CLIENT_ID, grant_type: 'refresh_token', refresh_token: refreshToken },
      { 'Content-Type': 'application/json' },
    );
    if (res.status < 200 || res.status >= 300) throw new CodexOAuthHttpError(res.status);
    const body = res.data as {
      id_token?: unknown;
      access_token?: unknown;
      refresh_token?: unknown;
    };
    return {
      idToken: typeof body.id_token === 'string' ? body.id_token : undefined,
      accessToken: typeof body.access_token === 'string' ? body.access_token : undefined,
      refreshToken: typeof body.refresh_token === 'string' ? body.refresh_token : undefined,
    };
  }

  /**
   * Assemble the `~/.codex/auth.json` blob we persist (encrypted). `account_id` is pulled from the id_token.
   * `nowIso` is injected so callers stamp a real timestamp (kept out of this pure builder for testability).
   */
  buildAuthJson(tokens: CodexTokens, nowIso: string): string {
    const { accountId } = decodeCodexIdentity(tokens.idToken);
    return JSON.stringify({
      OPENAI_API_KEY: null,
      tokens: {
        id_token: tokens.idToken,
        access_token: tokens.accessToken,
        refresh_token: tokens.refreshToken,
        account_id: accountId ?? null,
      },
      last_refresh: nowIso,
      auth_mode: 'chatgpt',
    });
  }

  private async timedPost(
    url: string,
    data: unknown,
    headers: Record<string, string>,
  ): Promise<AxiosResponse> {
    return axios.post(url, data, {
      headers,
      timeout: FETCH_TIMEOUT_MS,
      validateStatus: () => true,
    });
  }

  private parseTokens(raw: unknown): CodexTokens {
    const body = (raw ?? {}) as {
      id_token?: unknown;
      access_token?: unknown;
      refresh_token?: unknown;
    };
    if (
      typeof body.id_token !== 'string' ||
      typeof body.access_token !== 'string' ||
      typeof body.refresh_token !== 'string'
    ) {
      throw new Error('codex token response missing id_token/access_token/refresh_token');
    }
    return {
      idToken: body.id_token,
      accessToken: body.access_token,
      refreshToken: body.refresh_token,
    };
  }
}
