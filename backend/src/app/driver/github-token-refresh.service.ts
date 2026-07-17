import { Inject, Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { CredentialResolver } from '../onboarding/credential-resolver.service';
import { DB_CONNECTION } from '../persistence/database.module';
import { JobSandboxEntity } from '../persistence/entities';
import { SANDBOX_PROVIDER, type SandboxProvider } from '../sandbox/sandbox-provider.port';

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
