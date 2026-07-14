import { EnvService } from '@core/config/env/env.service';
import { Injectable } from '@nestjs/common';

/**
 * The single source of truth for "which backend commit is this process running". `GIT_SHA` is injected
 * as a Docker build-arg (mirrors the web app's `NEXT_PUBLIC_GIT_SHA`) — see `infra/backend.Dockerfile`
 * and the CI backend build step. Unset locally, so `sha` resolves to `"dev"`.
 *
 * Because the backend runs blue/green and an old leader keeps driving in-flight turns for up to a ~2-min
 * drain after a deploy, `sha` is the commit of the PROCESS that wrote a given row, not necessarily the
 * latest deployed commit — that's the point: it lets analytics/debugging tell which code actually
 * produced a row.
 */
@Injectable()
export class AppVersionService {
  readonly sha: string;

  constructor(env: EnvService) {
    this.sha = env.get('GIT_SHA')?.trim() || 'dev';
  }
}
