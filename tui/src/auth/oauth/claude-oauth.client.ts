import { Injectable } from "@nestjs/common";
import { createHash, randomBytes } from "node:crypto";

/**
 * Claude.ai subscription OAuth — Authorization Code + PKCE (S256), manual paste-back, the same flow
 * the Claude Code CLI uses. Anthropic hosts a callback page that just displays `code#state` for the
 * user to paste; there is no server-side redirect, which is what makes this workable from a
 * terminal with no listening port.
 *
 * Ported from `backend/src/host/agent-credentials/oauth/claude-oauth.client.ts` rather than
 * imported — the TUI is standalone, and this is ~100 lines of PKCE and one HTTP round-trip.
 * Constants are public values, so they live in code rather than env.
 */
const AUTHORIZE_URL = "https://claude.com/cai/oauth/authorize";
const TOKEN_URL = "https://platform.claude.com/v1/oauth/token";
const CLIENT_ID = "9d1c250a-e61b-44d9-88ed-5944d1962f5e";
const SCOPES = "org:create_api_key user:profile user:inference";
const MANUAL_REDIRECT_URL = "https://platform.claude.com/oauth/code/callback";
const FETCH_TIMEOUT_MS = 10_000;

export type Pkce = { verifier: string; challenge: string; state: string };

export type ClaudeTokenSet = {
  accessToken: string;
  refreshToken: string;
  /** Epoch ms. */
  expiresAt: number;
  scopes?: string;
  subscriptionType?: string;
  accountEmail?: string;
};

/** Exactly the shape the Claude SDK expects at `<config-dir>/.credentials.json`. */
export type ClaudeCredentialBlob = {
  claudeAiOauth: {
    accessToken: string;
    refreshToken: string;
    expiresAt: number;
    scopes: string[];
    subscriptionType?: string;
  };
};

export class ClaudeOAuthHttpError extends Error {
  constructor(readonly status: number) {
    super(`claude oauth token request failed: HTTP ${status}`);
    this.name = "ClaudeOAuthHttpError";
  }
}

@Injectable()
export class ClaudeOAuthClient {
  generatePkce(): Pkce {
    const verifier = base64url(randomBytes(32));
    const challenge = base64url(createHash("sha256").update(verifier).digest());
    const state = base64url(randomBytes(32));
    return { verifier, challenge, state };
  }

  buildAuthorizeUrl(pkce: Pkce): string {
    const url = new URL(AUTHORIZE_URL);
    url.searchParams.set("client_id", CLIENT_ID);
    url.searchParams.set("response_type", "code");
    url.searchParams.set("redirect_uri", MANUAL_REDIRECT_URL);
    url.searchParams.set("scope", SCOPES);
    url.searchParams.set("code_challenge", pkce.challenge);
    url.searchParams.set("code_challenge_method", "S256");
    url.searchParams.set("state", pkce.state);
    url.searchParams.set("code", "true"); // manual-code mode
    return url.toString();
  }

  /** The pasted value is `code#state`; the fragment is a tamper check, not part of the code. */
  async exchangeCode(input: {
    code: string;
    verifier: string;
    state: string;
  }): Promise<ClaudeTokenSet> {
    const [bareCode, fragmentState] = input.code.trim().split("#");
    if (fragmentState !== undefined && fragmentState !== input.state) {
      throw new Error("claude oauth: state mismatch in pasted code");
    }
    return this.postForTokenSet({
      grant_type: "authorization_code",
      code: bareCode ?? "",
      state: input.state,
      redirect_uri: MANUAL_REDIRECT_URL,
      client_id: CLIENT_ID,
      code_verifier: input.verifier,
    });
  }

  async refresh(refreshToken: string): Promise<ClaudeTokenSet> {
    return this.postForTokenSet({
      grant_type: "refresh_token",
      refresh_token: refreshToken,
      client_id: CLIENT_ID,
    });
  }

  /** 400/401/403 mean the credential is dead, not that the network blipped — don't retry those. */
  isHardAuthFailure(status: number): boolean {
    return status === 400 || status === 401 || status === 403;
  }

  toBlob(token: ClaudeTokenSet): ClaudeCredentialBlob {
    return {
      claudeAiOauth: {
        accessToken: token.accessToken,
        refreshToken: token.refreshToken,
        expiresAt: token.expiresAt,
        scopes: token.scopes ? token.scopes.split(/\s+/).filter(Boolean) : [],
        ...(token.subscriptionType === undefined
          ? {}
          : { subscriptionType: token.subscriptionType }),
      },
    };
  }

  private async postForTokenSet(
    body: Record<string, string>,
  ): Promise<ClaudeTokenSet> {
    const response = await fetch(TOKEN_URL, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
    if (!response.ok) throw new ClaudeOAuthHttpError(response.status);
    return this.parseTokenSet(await response.json());
  }

  parseTokenSet(raw: unknown): ClaudeTokenSet {
    const body = (raw ?? {}) as {
      access_token?: unknown;
      refresh_token?: unknown;
      expires_in?: unknown;
      scope?: unknown;
      subscription_type?: unknown;
      account?: { subscription_type?: unknown; email_address?: unknown };
    };
    const accessToken = body.access_token;
    const refreshToken = body.refresh_token;
    if (typeof accessToken !== "string" || typeof refreshToken !== "string") {
      throw new Error(
        "claude oauth: token response missing access_token/refresh_token",
      );
    }
    const expiresIn =
      typeof body.expires_in === "number" ? body.expires_in : 3600;
    const subscriptionType =
      pickString(body.subscription_type) ??
      pickString(body.account?.subscription_type);
    const accountEmail = pickString(body.account?.email_address);

    return {
      accessToken,
      refreshToken,
      expiresAt: Date.now() + expiresIn * 1000,
      ...(pickString(body.scope) === undefined
        ? {}
        : { scopes: pickString(body.scope) as string }),
      ...(subscriptionType === undefined ? {} : { subscriptionType }),
      ...(accountEmail === undefined ? {} : { accountEmail }),
    };
  }
}

function pickString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function base64url(buffer: Buffer): string {
  return buffer.toString("base64url");
}
