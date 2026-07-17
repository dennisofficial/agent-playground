import { Injectable, Logger } from '@nestjs/common';
import type { SessionEngine } from '@shared/domain';
import type { AuthRefreshSink } from '@shared/engine/auth-refresh.port';
import { ClaudeCredentialStore } from './claude-credential.store';
import { TenantCredentialStore } from './tenant-credential.store';

@Injectable()
export class AuthRefreshSinkService implements AuthRefreshSink {
  private readonly logger = new Logger(AuthRefreshSinkService.name);

  constructor(
    private readonly tenantStore: TenantCredentialStore,
    private readonly claudeStore: ClaudeCredentialStore,
  ) {}

  async persist(
    provenance: { orgId: string; engine: SessionEngine; credentialId?: string },
    secret: string,
  ): Promise<void> {
    const { orgId, engine, credentialId } = provenance;
    try {
      if (engine === 'codex') await this.tenantStore.advanceCodexAuthSecret(orgId, secret);
      else if (engine === 'claude')
        await this.claudeStore.advanceClaudeCredential(orgId, credentialId, secret);
    } catch (err) {
      this.logger.warn(
        `${engine} auth-refresh persist failed for team=${orgId}: ${err instanceof Error ? err.message : err}`,
      );
    }
  }
}
