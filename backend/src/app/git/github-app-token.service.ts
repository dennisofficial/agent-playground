import { EnvService } from '@core/config/env/env.service';
import { Injectable } from '@nestjs/common';
import { createSign } from 'node:crypto';

/**
 * Zero-dep, hand-rolled GitHub App client: signs the App-level RS256 JWT (`node:crypto`, no
 * `jsonwebtoken`), mints/caches per-installation access tokens, and resolves the App's own bot commit
 * identity. `fetchImpl` is the spec seam, mirroring `GithubPrService`. The JWT and every minted
 * installation token stay host-side — errors carry GitHub's status + message but NEVER the JWT or token.
 */

const API = 'https://api.github.com';

@Injectable()
export class GitHubAppTokenService {
  fetchImpl: typeof fetch = fetch;

  private cache = new Map<string, { token: string; expiresAtMs: number }>();
  private botIdentity?: { name: string; email: string };
  private slug?: string;

  constructor(private readonly env: EnvService) {}

  /** App auth is configured: a private key AND an issuer (client id or numeric app id) are present. */
  isConfigured(): boolean {
    return (
      !!this.env.get('GITHUB_APP_PRIVATE_KEY') &&
      !!(this.env.get('GITHUB_APP_CLIENT_ID') || this.env.get('GITHUB_APP_ID'))
    );
  }

  private loadPrivateKey(): string {
    const raw = this.env.get('GITHUB_APP_PRIVATE_KEY');
    if (!raw) throw new Error('GITHUB_APP_PRIVATE_KEY is not configured');
    const pem = raw.includes('BEGIN') ? raw : Buffer.from(raw, 'base64').toString('utf8');
    return pem.replace(/\\n/g, '\n');
  }

  private appJwt(): string {
    const clientId = this.env.get('GITHUB_APP_CLIENT_ID');
    const appId = this.env.get('GITHUB_APP_ID');
    const iss = clientId ?? appId;
    if (!iss) {
      throw new Error(
        'GITHUB_APP_CLIENT_ID or GITHUB_APP_ID must be configured to sign an App JWT',
      );
    }
    const nowSec = Math.floor(Date.now() / 1000);
    const header = { alg: 'RS256', typ: 'JWT' };
    const payload = { iat: nowSec - 60, exp: nowSec + 540, iss };
    const signingInput = `${base64url(JSON.stringify(header))}.${base64url(JSON.stringify(payload))}`;
    const sig = createSign('RSA-SHA256').update(signingInput).end().sign(this.loadPrivateKey());
    return `${signingInput}.${base64url(sig)}`;
  }

  private githubHeaders(): Record<string, string> {
    return {
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
      'User-Agent': 'atlas',
    };
  }

  private appHeaders(jwt: string): Record<string, string> {
    return {
      ...this.githubHeaders(),
      Authorization: `Bearer ${jwt}`,
    };
  }

  /**
   * A live installation access token, cached until it has under 5 minutes left. Retries a transient
   * (network throw / 5xx) mint failure up to 3 attempts with a short backoff before giving up.
   */
  async getInstallationToken(installationId: string): Promise<string> {
    const cached = this.cache.get(installationId);
    if (cached && cached.expiresAtMs - Date.now() > 5 * 60_000) return cached.token;

    const MAX_ATTEMPTS = 3;
    let lastError: Error | undefined;
    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
      let res: Response;
      try {
        res = await this.fetchImpl(`${API}/app/installations/${installationId}/access_tokens`, {
          method: 'POST',
          headers: this.appHeaders(this.appJwt()),
        });
      } catch (e) {
        lastError = e as Error;
        if (attempt < MAX_ATTEMPTS) {
          await new Promise((r) => setTimeout(r, 250 * attempt));
          continue;
        }
        throw new Error(`installation-token mint failed: network error (${lastError.message})`);
      }
      if (res.ok) {
        const body = (await res.json()) as {
          token: string;
          expires_at: string;
        };
        this.cache.set(installationId, {
          token: body.token,
          expiresAtMs: Date.parse(body.expires_at),
        });
        return body.token;
      }
      if (res.status >= 500 && attempt < MAX_ATTEMPTS) {
        await new Promise((r) => setTimeout(r, 250 * attempt));
        continue;
      }
      const errBody = (await res.json().catch(() => ({}))) as {
        message?: string;
      };
      throw new Error(
        `installation-token mint failed: ${res.status} ${errBody.message ?? 'no detail'}`,
      );
    }
    // Unreachable — the loop above always returns or throws.
    throw new Error(`installation-token mint failed: ${lastError?.message ?? 'unknown error'}`);
  }

  /** The installation id for an org (or a specific repo). null on 404 (App not installed there). */
  async findInstallationId(owner: string, repo?: string): Promise<string | null> {
    const url = repo
      ? `${API}/repos/${owner}/${repo}/installation`
      : `${API}/orgs/${owner}/installation`;
    const res = await this.fetchImpl(url, {
      headers: this.appHeaders(this.appJwt()),
    });
    if (res.status === 404) return null;
    if (!res.ok) {
      const errBody = (await res.json().catch(() => ({}))) as {
        message?: string;
      };
      throw new Error(
        `installation lookup failed: ${res.status} ${errBody.message ?? 'no detail'}`,
      );
    }
    const body = (await res.json()) as { id: number };
    return String(body.id);
  }

  /** Installation detail (account login/id/type) — used for the connect callback's account verification. null on 404. */
  async getInstallation(installationId: string): Promise<{
    id: string;
    account: { login: string; id: number; type: string };
  } | null> {
    const res = await this.fetchImpl(`${API}/app/installations/${installationId}`, {
      headers: this.appHeaders(this.appJwt()),
    });
    if (res.status === 404) return null;
    if (!res.ok) {
      const errBody = (await res.json().catch(() => ({}))) as {
        message?: string;
      };
      throw new Error(
        `installation lookup failed: ${res.status} ${errBody.message ?? 'no detail'}`,
      );
    }
    const body = (await res.json()) as {
      id: number;
      account: { login: string; id: number; type: string };
    };
    return {
      id: String(body.id),
      account: {
        login: body.account.login,
        id: body.account.id,
        type: body.account.type,
      },
    };
  }

  /** The Atlas App's URL slug (from `GET /app`) — used to build the org's install URL. Memoized (static per app). */
  async appSlug(): Promise<string> {
    if (this.slug) return this.slug;
    const appRes = await this.fetchImpl(`${API}/app`, {
      headers: this.appHeaders(this.appJwt()),
    });
    if (!appRes.ok) {
      const errBody = (await appRes.json().catch(() => ({}))) as {
        message?: string;
      };
      throw new Error(`app lookup failed: ${appRes.status} ${errBody.message ?? 'no detail'}`);
    }
    const { slug } = (await appRes.json()) as { slug: string };
    this.slug = slug;
    return slug;
  }

  /** The App's own bot commit identity (name/email) — an installation token isn't a user, so App-mode commits attribute to the bot. Memoized (static per app). */
  async appBotIdentity(): Promise<{ name: string; email: string }> {
    if (this.botIdentity) return this.botIdentity;
    const slug = await this.appSlug();
    const botLogin = `${slug}[bot]`;
    const userRes = await this.fetchImpl(`${API}/users/${encodeURIComponent(botLogin)}`, {
      headers: this.githubHeaders(),
    });
    if (!userRes.ok) {
      const errBody = (await userRes.json().catch(() => ({}))) as {
        message?: string;
      };
      throw new Error(
        `bot user lookup failed: ${userRes.status} ${errBody.message ?? 'no detail'}`,
      );
    }
    const { id } = (await userRes.json()) as { id: number };
    const identity = {
      name: botLogin,
      email: `${id}+${botLogin}@users.noreply.github.com`,
    };
    this.botIdentity = identity;
    return identity;
  }
}

function base64url(input: string | Buffer): string {
  const b64 = (Buffer.isBuffer(input) ? input : Buffer.from(input)).toString('base64');
  return b64.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
