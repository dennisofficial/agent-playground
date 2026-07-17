import { EnvService } from '@core/config/env/env.service';
import { Injectable, Logger } from '@nestjs/common';
import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { gitAuthEnv } from '../git';

const execFileAsync = promisify(execFile);

/**
 * The host-maintained, READ-ONLY cross-repo reference library (D4). The host clones the repos a channel
 * wants to reference into a per-tenant dir, which the `SandboxManager` bind-mounts read-only at `/refs`
 * in every sandbox — so an agent can read OTHER repos without those repos' tokens ever entering the
 * (untrusted) sandbox. `ensureReference` clones on first use, fetches on later calls.
 *
 * SCOPE (this pass): the mount + clone/fetch mechanism. FOLLOW-UP (noted): resolving each referenced
 * repo's own GitHub token from the projects registry, a periodic refresh timer, GC of stale clones, and
 * the agent-facing tool that calls this. Today the caller passes the url/token explicitly.
 */
@Injectable()
export class SandboxRefsService {
  private readonly logger = new Logger(SandboxRefsService.name);

  constructor(private readonly env: EnvService) {}

  /** The reference-library root on the host (REFS_ROOT ?? REFS_ROOT); undefined → /refs disabled. */
  refsRoot(): string | undefined {
    return this.env.get('REFS_ROOT');
  }

  /** The per-tenant dir mounted at /refs (mirrors SandboxManager's mapping). */
  teamRefsDir(orgId: string): string | undefined {
    const root = this.refsRoot();
    if (!root) return undefined;
    return join(root, this.safe(orgId));
  }

  /**
   * Ensure a referenced repo is cloned into the tenant's library (clone on first use, fetch otherwise).
   * Returns the in-sandbox path (`/refs/<slug>`) the agent reads, or undefined when /refs is disabled.
   * The token authenticates the clone/fetch only (via GIT_CONFIG_* env) — never persisted to config.
   */
  async ensureReference(input: {
    orgId: string;
    repoId: string;
    gitUrl: string;
    token?: string;
  }): Promise<string | undefined> {
    const dir = this.teamRefsDir(input.orgId);
    if (!dir) {
      this.logger.warn('ensureReference called but no REFS_ROOT/REFS_ROOT configured — skipping');
      return undefined;
    }
    const slug = this.safe(input.repoId);
    const dest = join(dir, slug);
    await mkdir(dir, { recursive: true });

    const env: NodeJS.ProcessEnv = {
      ...process.env,
      GIT_TERMINAL_PROMPT: '0',
      ...gitAuthEnv(input.gitUrl, input.token),
    };
    if (existsSync(join(dest, '.git'))) {
      await execFileAsync('git', ['-C', dest, 'fetch', '--all', '--prune'], {
        env,
      });
    } else {
      this.logger.log(`cloning reference ${input.gitUrl} → ${dest}`);
      await execFileAsync('git', ['clone', input.gitUrl, dest], { env });
    }
    return `/refs/${slug}`;
  }

  private safe(s: string): string {
    return s.replace(/[^a-z0-9_-]/gi, '_') || 'x';
  }
}
