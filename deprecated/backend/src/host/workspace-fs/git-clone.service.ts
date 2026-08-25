import { Injectable, Logger } from '@nestjs/common';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const exec = promisify(execFile);

export interface GitCloneOptions {
  url: string;
  branch: string;
  /** Bearer token for a private clone, or `null` for a public repo. */
  token: string | null;
  /** Destination directory — must exist and be empty. */
  dest: string;
}

/**
 * The git mechanism, isolated so the security-sensitive shell-out lives in one testable place. Clones over
 * HTTPS with an `x-access-token` credential when a token is present, then strips the credential from the
 * remote so it never lingers in `.git/config`, and scrubs the token from any surfaced error.
 *
 * The natural home for future git operations over a materialized workspace (diffs, status, log).
 */
@Injectable()
export class GitCloneService {
  private readonly logger = new Logger(this.constructor.name);

  async clone({ url, branch, token, dest }: GitCloneOptions): Promise<void> {
    const cloneUrl = token ? url.replace(/^https:\/\//, `https://x-access-token:${token}@`) : url;
    try {
      await exec('git', ['clone', '--branch', branch, '--', cloneUrl, dest]);
      await exec('git', ['-C', dest, 'remote', 'set-url', 'origin', url]);
    } catch (err) {
      // Never let the token reach a log or a status pill — scrub it from whatever git surfaced.
      const message = GitCloneService.scrub(GitCloneService.reason(err), token);
      throw new Error(`git clone failed: ${message}`);
    }
    this.logger.log(`cloned ${url} (branch ${branch}) into ${dest}`);
  }

  private static reason(err: unknown): string {
    return err instanceof Error ? err.message : String(err);
  }

  private static scrub(text: string, token: string | null): string {
    return token ? text.split(token).join('***') : text;
  }
}
