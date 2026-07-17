import { Inject, Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { DB_CONNECTION } from '../persistence/database.module';
import { JobSandboxEntity } from '../persistence/entities';
import { CredentialResolver } from '../onboarding/credential-resolver.service';
import {
  SANDBOX_PROVIDER,
  type SandboxProvider,
} from '../sandbox/sandbox-provider.port';

/**
 * Leader-gated periodic sweep (~2 min, DriverModule) that keeps every ACTIVE app-mode sandbox's in-sandbox
 * GitHub token file current. An installation token expires ~hourly and a single build turn can run >1h in one
 * frozen exec env, so the in-sandbox git `credential.helper` reads the token from a host-refreshed FILE
 * instead — this sweep is what refreshes that file. Cadence MUST stay strictly under the token service's
 * 5-min pre-expiry refresh window (`GitHubAppTokenService` serves the cached token until it has <5 min left),
 * NOT merely under the ~55-min lifetime: the 5-min window is the governing margin, so a ≥5-min sweep could
 * write a still-cached token that then expires before the next sweep. At 2 min at least one sweep always
 * lands inside that window and writes a freshly-minted token before the old one expires. PAT-mode + inactive
 * sandboxes are skipped (they use the static extraheader, no file). Best-effort per sandbox: a transient
 * mint/GitHub error is logged and never aborts the sweep. Mirrors the enumeration in JobLifecycleService.reapIdle.
 */
@Injectable()
export class GithubTokenRefreshService {
  private readonly logger = new Logger(GithubTokenRefreshService.name);

  constructor(
    @InjectRepository(JobSandboxEntity, DB_CONNECTION)
    private readonly sandboxes: Repository<JobSandboxEntity>,
    private readonly creds: CredentialResolver,
    @Inject(SANDBOX_PROVIDER) private readonly sandbox: SandboxProvider,
  ) {}

  async tick(): Promise<void> {
    const rows = await this.sandboxes.find({
      where: { lifecycle: 'attached' },
    });
    for (const row of rows) {
      if (!row.container_id) continue;
      try {
        const mode = await this.creds.githubAuthMode(row.org_id);
        if (mode !== 'app') continue; // pat-mode sandboxes use the static extraheader — no file to refresh
        const token = await this.creds.githubToken(row.org_id);
        if (!token) continue; // app-mode but token unresolvable this tick (mint blip / no installation) — skip
        await this.sandbox.writeGithubTokenFile?.(row.job_id, token);
      } catch (err) {
        this.logger.warn(
          `token-refresh: sandbox ${row.job_id.slice(0, 8)} skipped: ${(err as Error).message}`,
        );
      }
    }
  }
}
