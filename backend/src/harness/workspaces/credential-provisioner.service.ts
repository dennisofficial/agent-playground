import {
  Inject,
  Injectable,
  Logger,
  type OnApplicationShutdown,
} from '@nestjs/common';
import { gitAuthEnv } from '../projects/git-auth';
import { GithubTokenStore } from '../projects/github-token-store';
import { ProjectStore } from '../projects/project-store';
import {
  credReplyChannel,
  credRequestChannel,
  type CredentialReply,
  type CredentialRequest,
  type GitCredentialPayload,
} from './daemon-protocol';
import {
  REDIS_STREAM_PORT,
  type RedisStreamPort,
} from '../../_lib/redis/redis.port';
import { SandboxRegistry } from './sandbox-registry';

/**
 * The HOST side of the just-in-time credential-pull channel (Phase 6) — the piece deferred from Phase 5.
 *
 * For each managed workspace it subscribes to `ws:{id}:cred-req`. When the in-sandbox daemon needs a git
 * credential it PUBLISHes `{nonce, bootstrapToken}` there; this service:
 *   1. validates `bootstrapToken` against the token the host ISSUED for that workspace (SandboxRegistry);
 *   2. resolves the workspace's `(team, project)` → `ProjectStore.get` → `GithubTokenStore.resolve` and
 *      the author identity (provider-neutral `{kind:'pat', token, authorName, authorEmail}`, leaving room
 *      for a future GitHub-App kind);
 *   3. PUBLISHes the reply on `cred-reply:{nonce}` — `{ok:true, credential}` or `{ok:false, error}`.
 *
 * The token is NEVER logged. The channel is pub/sub (non-persisted) so a credential never lingers on the
 * bus. `watch(workspaceId)` is driven by `ContainerManagerService` (on create + on each reconciled
 * workspace) — no boot-order coupling: the manager subscribes us as it learns of sandboxes.
 *
 * LLM api key is NOT in this channel — it rides the per-run payload (Phase 7). This is GitHub-credential
 * only.
 */
@Injectable()
export class CredentialProvisionerService implements OnApplicationShutdown {
  private readonly logger = new Logger(CredentialProvisionerService.name);
  /** workspaceId → unsubscribe fn (so re-watching is idempotent and shutdown tears all down). */
  private readonly subscriptions = new Map<string, () => Promise<void>>();

  constructor(
    @Inject(REDIS_STREAM_PORT) private readonly redis: RedisStreamPort,
    private readonly registry: SandboxRegistry,
    private readonly projects: ProjectStore,
    private readonly tokens: GithubTokenStore,
  ) {}

  /** Subscribe to a workspace's cred-req channel (idempotent). Called by the manager on create/adopt. */
  async watch(workspaceId: string): Promise<void> {
    if (this.subscriptions.has(workspaceId)) return;
    const channel = credRequestChannel(workspaceId);
    const unsubscribe = await this.redis.subscribe(channel, (message) => {
      void this.handleRequest(workspaceId, message).catch((err) =>
        this.logger.error(
          `cred-req handling for ${workspaceId} threw: ${String(err)}`,
        ),
      );
    });
    this.subscriptions.set(workspaceId, unsubscribe);
    this.logger.log(`watching cred-req channel for ${workspaceId}`);
  }

  /** Stop watching a workspace (manager calls this on destroy). */
  async unwatch(workspaceId: string): Promise<void> {
    const unsub = this.subscriptions.get(workspaceId);
    if (!unsub) return;
    this.subscriptions.delete(workspaceId);
    await unsub().catch(() => undefined);
  }

  private async handleRequest(
    workspaceId: string,
    message: unknown,
  ): Promise<void> {
    const req = message as Partial<CredentialRequest> | undefined;
    if (!req || typeof req.nonce !== 'string' || !req.nonce) {
      this.logger.warn(
        `cred-req for ${workspaceId}: malformed request (no nonce) — dropped`,
      );
      return;
    }
    const reply = await this.resolveCredential(workspaceId, req);
    await this.redis
      .publish(credReplyChannel(req.nonce), reply)
      .catch((err) =>
        this.logger.warn(
          `cred-reply publish for ${workspaceId} failed: ${String(err)}`,
        ),
      );
  }

  /** Validate the bootstrap token, then resolve the GitHub credential. Returns a typed reply (never
   * throws to the caller — a failure becomes `{ok:false}`). Token never appears in any log line. */
  private async resolveCredential(
    workspaceId: string,
    req: Partial<CredentialRequest>,
  ): Promise<CredentialReply> {
    const expected = this.registry.bootstrapToken(workspaceId);
    if (!expected) {
      this.logger.warn(
        `cred-req for ${workspaceId}: no issued bootstrap token (unknown or adopted sandbox) — rejected`,
      );
      return { ok: false, error: 'no bootstrap token issued for this workspace' };
    }
    if (!safeEqual(req.bootstrapToken, expected)) {
      this.logger.warn(
        `cred-req for ${workspaceId}: bootstrap token mismatch — rejected`,
      );
      return { ok: false, error: 'bootstrap token mismatch' };
    }

    const rec = this.registry.get(workspaceId);
    if (!rec) {
      return { ok: false, error: 'workspace not found' };
    }
    const project = await this.projects
      .get(rec.team, rec.project)
      .catch(() => undefined);
    if (!project) {
      return {
        ok: false,
        error: `no registered project ${rec.team}/${rec.project}`,
      };
    }
    const resolved = await this.tokens
      .resolve(project.teamId, project.tokenName)
      .catch(() => undefined);
    const token = resolved?.token ?? '';
    // PUBLIC-REPO TOLERANCE: no resolvable token is NOT a failure — a public repo clones/fetches with no
    // auth header. We serve an EMPTY-token credential so the daemon's `gitAuthEnv` yields {} and the
    // clone proceeds unauthenticated; a genuinely private repo then fails at git with a legible
    // "Authentication failed", which is the correct error surface. A token present on a NON-GitHub remote
    // is still a hard failure (the token is unusable there) — only the no-token case is tolerated.
    if (token && Object.keys(gitAuthEnv(project.gitUrl, token)).length === 0) {
      return {
        ok: false,
        error: `repo ${project.gitUrl} is not an HTTPS GitHub remote — token auth doesn't apply`,
      };
    }

    const credential: GitCredentialPayload = {
      kind: 'pat',
      token,
      // The PAT-owner / bot identity. v1: a stable bot author keyed off the token name (the PAT's GitHub
      // login isn't resolved here to avoid an extra API round-trip on the hot path); Phase later can mint
      // a real identity. Provider-neutral envelope leaves room for a GitHub-App author.
      authorName: 'Agent',
      authorEmail: 'agent@agents.noreply',
    };
    this.logger.log(
      `issued git credential to ${workspaceId} (kind=pat, token=${token ? 'present' : 'EMPTY/public'})`,
    );
    return { ok: true, credential };
  }

  async onApplicationShutdown(): Promise<void> {
    for (const [id] of this.subscriptions) await this.unwatch(id);
  }
}

/** Length-constant-ish string compare (avoids leaking length-prefix timing for the token check). */
function safeEqual(a: string | undefined, b: string): boolean {
  if (typeof a !== 'string' || a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < b.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}
