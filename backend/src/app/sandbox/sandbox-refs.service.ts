import { EnvService } from '@core/config/env/env.service';
import { Injectable, Logger } from '@nestjs/common';
import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { gitAuthEnv } from '../git/git-auth';

const execFileAsync = promisify(execFile);

@Injectable()
export class SandboxRefsService {
  private readonly logger = new Logger(SandboxRefsService.name);

  constructor(private readonly env: EnvService) {}

  refsRoot(): string | undefined {
    return this.env.get('REFS_ROOT');
  }

  teamRefsDir(orgId: string): string | undefined {
    const root = this.refsRoot();
    if (!root) return undefined;
    return join(root, this.safe(orgId));
  }

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
