import { Injectable, Logger } from '@nestjs/common';
import { OrgCredentialsService } from '../org-credentials/credentials.service';
import { GithubApiService } from './github-api.service';
import { GithubAppTokenService } from './github-app-token.service';

export interface GitCommitIdentity {
  name: string;
  email: string;
}

@Injectable()
export class GithubTokenService {
  private readonly logger = new Logger(this.constructor.name);
  /** Human identity resolved from a PAT, cached by token string (matches the old GitIdentityService). */
  private readonly humanIdentityByToken = new Map<string, GitCommitIdentity>();

  constructor(
    private readonly credentials: OrgCredentialsService,
    private readonly appTokens: GithubAppTokenService,
    private readonly api: GithubApiService,
  ) {}

  async hostToken(orgId: string): Promise<string | null> {
    const installation = await this.credentials.getGithubAppInstallation(orgId);
    if (installation) {
      try {
        return await this.appTokens.getInstallationToken(installation.id);
      } catch (err) {
        this.logger.error(`installation-token mint failed for org ${orgId}: ${this.reason(err)}`);
        return null; // deliberately do NOT fall back to the PAT for a faceless operation
      }
    }
    return this.credentials.getGithubPat(orgId);
  }

  async sandboxToken(orgId: string): Promise<string | null> {
    const pat = await this.credentials.getGithubPat(orgId);
    if (pat) return pat;
    const installation = await this.credentials.getGithubAppInstallation(orgId);
    if (!installation) return null;
    try {
      return await this.appTokens.getInstallationToken(installation.id);
    } catch (err) {
      this.logger.error(`installation-token mint failed for org ${orgId}: ${this.reason(err)}`);
      return null;
    }
  }

  async commitIdentity(orgId: string): Promise<GitCommitIdentity | null> {
    const pat = await this.credentials.getGithubPat(orgId);
    if (pat) {
      const human = await this.humanIdentity(pat);
      if (human) return human;
    }
    // No PAT (or the PAT lookup failed) → wear the App's bot face when the org has an installation.
    const installation = await this.credentials.getGithubAppInstallation(orgId);
    if (installation) {
      try {
        return await this.appTokens.appBotIdentity();
      } catch (err) {
        this.logger.warn(`bot-identity lookup failed for org ${orgId}: ${this.reason(err)}`);
      }
    }
    return null;
  }

  async gitEnvForTurn(orgId: string, gitUrl: string): Promise<Record<string, string>> {
    const [token, identity] = await Promise.all([
      this.sandboxToken(orgId),
      this.commitIdentity(orgId),
    ]);

    const env: Record<string, string> = {};

    if (token && this.isHttpsGithub(gitUrl)) {
      const basic = Buffer.from(`x-access-token:${token}`).toString('base64');
      env.GIT_CONFIG_COUNT = '1';
      env.GIT_CONFIG_KEY_0 = 'http.https://github.com/.extraheader';
      env.GIT_CONFIG_VALUE_0 = `AUTHORIZATION: basic ${basic}`;
      env.GITHUB_TOKEN = token;
      env.GH_TOKEN = token;
      env.GIT_TERMINAL_PROMPT = '0';
    }

    if (identity) {
      env.GIT_AUTHOR_NAME = identity.name;
      env.GIT_AUTHOR_EMAIL = identity.email;
      env.GIT_COMMITTER_NAME = identity.name;
      env.GIT_COMMITTER_EMAIL = identity.email;
    }

    return env;
  }

  /** Whether the org has any usable GitHub credential (PAT or a connected App installation). */
  async hasAnyGithub(orgId: string): Promise<boolean> {
    if (await this.credentials.hasGithubPat(orgId)) return true;
    return !!(await this.credentials.getGithubAppInstallation(orgId));
  }

  private async humanIdentity(token: string): Promise<GitCommitIdentity | null> {
    const cached = this.humanIdentityByToken.get(token);
    if (cached) return cached;
    try {
      const u = await this.api.getAuthenticatedUser(token);
      const identity: GitCommitIdentity = {
        name: u.name?.trim() || u.login,
        email: `${u.id}+${u.login}@users.noreply.github.com`,
      };
      this.humanIdentityByToken.set(token, identity);
      return identity;
    } catch {
      return null;
    }
  }

  private isHttpsGithub(gitUrl: string): boolean {
    return gitUrl.startsWith('https://github.com/');
  }

  private reason(err: unknown): string {
    return err instanceof Error ? err.message : String(err);
  }
}
