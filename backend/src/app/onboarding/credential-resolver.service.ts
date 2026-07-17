import { Injectable, Logger } from '@nestjs/common';
import type { EngineAuth, SandboxGitIdentity } from '@shared/engine/engine.types';
import { GitIdentityService } from '../git/git-identity.service';
import { GitHubAppTokenService } from '../git/github-app-token.service';
import { ClaudeCredentialStore } from './claude-credential.store';
import { TenantCredentialStore, type TenantCredentials } from './tenant-credential.store';

@Injectable()
export class CredentialResolver {
  private readonly logger = new Logger(CredentialResolver.name);

  constructor(
    private readonly store: TenantCredentialStore,
    private readonly claudeStore: ClaudeCredentialStore,
    private readonly appTokens: GitHubAppTokenService,
    private readonly identities: GitIdentityService,
  ) {}

  async anthropicKey(orgId?: string): Promise<string | undefined> {
    if (!orgId) return undefined;
    return (await this.store.read(orgId))?.anthropicApiKey;
  }

  async openaiKey(orgId?: string): Promise<string | undefined> {
    if (!orgId) return undefined;
    return (await this.store.read(orgId))?.openaiApiKey;
  }

  async githubAuthMode(orgId?: string): Promise<'pat' | 'app'> {
    if (!orgId) return 'pat';
    const creds = await this.store.read(orgId);
    return creds ? this.effectiveCredential(creds) : 'pat';
  }

  private effectiveCredential(creds: TenantCredentials): 'app' | 'pat' {
    return creds.githubAuthMode === 'app' && creds.githubAppInstallationId ? 'app' : 'pat';
  }

  async githubToken(orgId?: string): Promise<string | undefined> {
    if (!orgId) return undefined;
    const creds = await this.store.read(orgId);
    if (!creds) return undefined;
    if (this.effectiveCredential(creds) === 'app') {
      try {
        return await this.appTokens.getInstallationToken(creds.githubAppInstallationId!);
      } catch (e) {
        this.logger.error(
          `installation-token mint failed for org ${orgId}: ${(e as Error).message}`,
        );
        return undefined;
      }
    }
    if (creds.githubAuthMode === 'app' && !creds.githubAppInstallationId) {
      this.logger.warn(`org ${orgId} is app-mode but has no installation id — falling back to PAT`);
    }
    return creds.githubPat;
  }

  async githubWriteIdentity(
    orgId?: string,
  ): Promise<{ identity?: SandboxGitIdentity; apiToken?: string }> {
    if (!orgId) return {};
    const creds = await this.store.read(orgId);
    if (!creds) return {};
    const cred = this.effectiveCredential(creds);
    if (cred === 'app') {
      try {
        const [identity, apiToken] = await Promise.all([
          this.appTokens.appBotIdentity(),
          this.appTokens.getInstallationToken(creds.githubAppInstallationId!), // present by effectiveCredential
        ]);
        return { identity, apiToken };
      } catch (e) {
        this.logger.warn(
          `app write-identity resolve failed for org ${orgId}: ${(e as Error).message}`,
        );
        return {};
      }
    }
    if (creds.githubPat) {
      const human = await this.identities.resolve(creds.githubPat);
      if (human) return { identity: human, apiToken: creds.githubPat };
    }
    return {}; // no usable credential — fail-open (q6)
  }

  async hostGithubToken(orgId?: string): Promise<string | undefined> {
    if (!orgId) return undefined;
    const creds = await this.store.read(orgId);
    if (!creds) return undefined;
    if (!creds.githubAppInstallationId) return creds.githubPat; // App absent → bootstrap/degraded PAT
    try {
      return await this.appTokens.getInstallationToken(creds.githubAppInstallationId);
    } catch (e) {
      this.logger.error(
        `host installation-token mint failed for org ${orgId}: ${(e as Error).message}`,
      );
      return undefined; // App present but mint failed → do NOT leak to PAT
    }
  }

  async engineAuth(
    orgId: string | undefined,
    engine: 'claude' | 'codex',
  ): Promise<EngineAuth | undefined> {
    if (!orgId) return undefined;
    if (engine === 'claude') {
      const sel = await this.claudeStore.getSelectedDecrypted(orgId);
      if (!sel) return undefined;
      return {
        secret: sel.secret,
        kind: sel.kind === 'personal' ? 'personal' : 'setup-token',
        refreshBack: { orgId, engine: 'claude', credentialId: sel.id },
      };
    }
    const creds = await this.store.read(orgId);
    const secret = creds?.codexAuthSecret;
    if (!secret) return undefined;
    return { secret, refreshBack: { orgId, engine } };
  }
}
