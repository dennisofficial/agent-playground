import { Inject, Injectable, Logger } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import {
  credReplyChannel,
  credRequestChannel,
  type CredentialReply,
  type CredentialRequest,
} from '@harness/workspaces/daemon-protocol';
import {
  REDIS_STREAM_PORT,
  type RedisStreamPort,
} from '../../_lib/redis/redis.port';
import type {
  GitCredentialProvider,
  ResolvedGitCredential,
} from './git-credential.provider';

/** How long a resolved credential is reused before re-pulling — short, so a rotated PAT / minted
 * GitHub-App token lands within the window (the host re-resolves on each request anyway). */
const CACHE_TTL_MS = 60_000;
/** How long to wait for the host's reply before giving up (the host might be momentarily busy). */
const REPLY_TIMEOUT_MS = 15_000;

/**
 * The DAEMON's git credential provider over Redis (Phase 6) — the credential-PULL counterpart to the
 * host `CredentialProvisionerService`. Implements the existing `GitCredentialProvider` port (so
 * `DaemonGitService` is untouched) by a cred-req/reply round-trip:
 *
 *   1. subscribe `cred-reply:{nonce}` (a fresh nonce per request);
 *   2. PUBLISH `{nonce, bootstrapToken}` on `ws:{WORKSPACE_ID}:cred-req`;
 *   3. await the reply on the nonce channel → the resolved `{token, authorName, authorEmail}`.
 *
 * `WORKSPACE_ID` + `DAEMON_BOOTSTRAP_TOKEN` are read directly from `process.env` (injected at container
 * creation by the host; the daemon's EnvService is typed over the host IEnvConfig which doesn't carry
 * them — same pattern as the consumer loop's WORKSPACE_ID and `EnvGitCredentialProvider`'s GIT_*).
 *
 * A short cache avoids a round-trip on every git op within a turn. The credential token is NEVER logged.
 */
@Injectable()
export class RedisGitCredentialProvider implements GitCredentialProvider {
  private readonly logger = new Logger(RedisGitCredentialProvider.name);
  private cached?: { credential: ResolvedGitCredential; expires: number };

  constructor(
    @Inject(REDIS_STREAM_PORT) private readonly redis: RedisStreamPort,
  ) {}

  async resolve(): Promise<ResolvedGitCredential> {
    const hit = this.cached;
    if (hit && hit.expires > Date.now()) return hit.credential;
    const credential = await this.pull();
    this.cached = { credential, expires: Date.now() + CACHE_TTL_MS };
    return credential;
  }

  private async pull(): Promise<ResolvedGitCredential> {
    const workspaceId = process.env.WORKSPACE_ID?.trim();
    const bootstrapToken = process.env.DAEMON_BOOTSTRAP_TOKEN ?? '';
    if (!workspaceId) {
      throw new Error(
        'RedisGitCredentialProvider: WORKSPACE_ID unset — not running as a sandbox daemon.',
      );
    }

    const nonce = randomUUID();
    const replyChannel = credReplyChannel(nonce);

    // Subscribe FIRST so the host's reply can't race ahead of our listener.
    let resolveReply: (r: CredentialReply) => void;
    const replyPromise = new Promise<CredentialReply>((res) => {
      resolveReply = res;
    });
    const unsubscribe = await this.redis.subscribe(replyChannel, (message) => {
      resolveReply(message as CredentialReply);
    });

    try {
      const request: CredentialRequest = { nonce, bootstrapToken };
      await this.redis.publish(credRequestChannel(workspaceId), request);

      const reply = await withTimeout(replyPromise, REPLY_TIMEOUT_MS);
      if (!reply.ok) {
        throw new Error(`host refused git credential: ${reply.error}`);
      }
      this.logger.log(`pulled git credential (kind=${reply.credential.kind})`);
      return {
        token: reply.credential.token,
        authorName: reply.credential.authorName,
        authorEmail: reply.credential.authorEmail,
      };
    } finally {
      await unsubscribe().catch(() => undefined);
    }
  }
}

/** Reject if the promise hasn't settled within `ms` (the host never answered). */
function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const t = setTimeout(
      () => reject(new Error(`git credential pull timed out after ${ms}ms`)),
      ms,
    );
    if (typeof t.unref === 'function') t.unref();
    p.then(
      (v) => {
        clearTimeout(t);
        resolve(v);
      },
      (err) => {
        clearTimeout(t);
        reject(err instanceof Error ? err : new Error(String(err)));
      },
    );
  });
}
