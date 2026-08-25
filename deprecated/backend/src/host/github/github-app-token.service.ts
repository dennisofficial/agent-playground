import { EnvService } from '@core/config/env/env.service';
import { OCTOKIT_SDK, type OctokitSdk } from '@lib/esm/octokit.provider';
import { Inject, Injectable, Logger } from '@nestjs/common';
import { throttleOptions } from './github-octokit';

type OctokitInstance = InstanceType<OctokitSdk['AtlasOctokit']>;

@Injectable()
export class GithubAppTokenService {
  private readonly logger = new Logger(this.constructor.name);
  /** Test seam: swap the underlying fetch. */
  fetchImpl: typeof fetch = fetch;

  private readonly appId: string;
  private readonly slug: string;
  private readonly privateKey: string;
  private _octokit?: OctokitInstance;
  private _publicOctokit?: OctokitInstance;
  private botIdentity?: { name: string; email: string };

  constructor(
    env: EnvService,
    @Inject(OCTOKIT_SDK) private readonly sdk: OctokitSdk,
  ) {
    this.appId = env.get('GITHUB_APP_ID');
    this.slug = env.get('GITHUB_APP_SLUG');
    this.privateKey = this.normalizePrivateKey(env.get('GITHUB_APP_PRIVATE_KEY'));
  }

  /** A short-lived installation token (auth-app mints + caches it internally, refreshing before expiry). */
  async getInstallationToken(installationId: string): Promise<string> {
    const auth = (await this.octokit().auth({
      type: 'installation',
      installationId: Number(installationId),
    })) as { token: string };
    return auth.token;
  }

  /** `GET /app/installations/{id}` — the installation + its account login, or null when it doesn't exist. */
  async getInstallation(
    installationId: string,
  ): Promise<{ id: string; accountLogin: string | null } | null> {
    try {
      const { data } = await this.octokit().rest.apps.getInstallation({
        installation_id: Number(installationId),
      });
      const account = data.account;
      const accountLogin = account && 'login' in account ? account.login : null;
      return { id: String(data.id), accountLogin };
    } catch (err) {
      if (err instanceof this.sdk.RequestError && err.status === 404) return null;
      throw err;
    }
  }

  /** The App's slug — a static, known property of the App (from env). */
  appSlug(): string {
    return this.slug;
  }

  async appBotIdentity(): Promise<{ name: string; email: string }> {
    if (this.botIdentity) return this.botIdentity;
    const botLogin = `${this.slug}[bot]`;
    // A public endpoint — use an unauthenticated client; the App-auth client would force installation
    // auth on every request. Memoized, so the unauthenticated rate limit is a non-issue.
    const { data } = await this.unauthedOctokit().rest.users.getByUsername({ username: botLogin });
    this.botIdentity = { name: botLogin, email: `${data.id}+${botLogin}@users.noreply.github.com` };
    return this.botIdentity;
  }

  /** App-authenticated client — auth-app signs the JWT + mints/caches installation tokens per request. */
  private octokit(): OctokitInstance {
    return (this._octokit ??= new this.sdk.AtlasOctokit({
      authStrategy: this.sdk.createAppAuth,
      auth: { appId: Number(this.appId), privateKey: this.privateKey },
      userAgent: 'atlas',
      throttle: throttleOptions(this.logger),
      request: { fetch: this.fetchImpl },
    }));
  }

  /** Unauthenticated client for public endpoints (bot-user lookup). Lazily built for the {@link fetchImpl} seam. */
  private unauthedOctokit(): OctokitInstance {
    return (this._publicOctokit ??= new this.sdk.AtlasOctokit({
      userAgent: 'atlas',
      throttle: throttleOptions(this.logger),
      request: { fetch: this.fetchImpl },
    }));
  }

  private normalizePrivateKey(raw: string): string {
    const pem = raw.includes('BEGIN') ? raw : Buffer.from(raw, 'base64').toString('utf8');
    return pem.replace(/\\n/g, '\n');
  }
}
