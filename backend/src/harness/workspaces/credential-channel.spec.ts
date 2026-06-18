/**
 * Phase 6 credential-pull channel round-trip — the daemon `RedisGitCredentialProvider` ↔ host
 * `CredentialProvisionerService`, end to end over the in-memory Redis fake (NO live Redis). One
 * `InMemoryRedisStream` is shared by both sides, so the daemon's cred-req PUBLISH reaches the host's
 * subscription and the host's reply reaches the daemon — exactly the production path minus ioredis.
 *
 * Covers:
 *   - a valid request (correct bootstrap token) resolves the GitHub token + author identity;
 *   - a BAD bootstrap token is rejected (the daemon's pull throws, no credential leaks).
 * `ProjectStore`/`GithubTokenStore` are mocked.
 */
import { Logger } from '@nestjs/common';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ProjectStore } from '../projects/project-store';
import type { GithubTokenStore } from '../projects/github-token-store';
import { InMemoryRedisStream } from '../../_lib/redis/in-memory-redis-stream';
import { RedisGitCredentialProvider } from '../../daemon/git/redis-git-credential.provider';
import { CredentialProvisionerService } from './credential-provisioner.service';
import { SandboxRegistry, type SandboxRecord } from './sandbox-registry';

const TEAM = 'team-1';
const PROJECT = 'proj-1';
const REPO = 'https://github.com/acme/proj-1';
const WORKSPACE_ID = 'uuid-workspace-1';
const ISSUED_TOKEN = 'bootstrap-secret-abc123';
const GH_TOKEN = 'ghp_resolvedPAT';

function makeProjects(): ProjectStore {
  return {
    get: vi.fn(async (team: string, project: string) =>
      team === TEAM && project === PROJECT
        ? {
            teamId: TEAM,
            projectId: PROJECT,
            gitUrl: REPO,
            tokenName: 'default',
          }
        : undefined,
    ),
  } as unknown as ProjectStore;
}

function makeTokens(): GithubTokenStore {
  return {
    resolve: vi.fn(async () => ({ name: 'default', token: GH_TOKEN })),
  } as unknown as GithubTokenStore;
}

function seedSandbox(registry: SandboxRegistry, over: Partial<SandboxRecord> = {}): void {
  registry.upsert({
    workspaceId: WORKSPACE_ID,
    team: TEAM,
    project: PROJECT,
    repo: REPO,
    containerId: 'c-1',
    status: 'running',
    bootstrapToken: ISSUED_TOKEN,
    ...over,
  });
}

describe('Phase 6 credential-pull channel (in-memory Redis)', () => {
  let redis: InMemoryRedisStream;
  let registry: SandboxRegistry;
  let provisioner: CredentialProvisionerService;
  const prevWorkspaceId = process.env.WORKSPACE_ID;
  const prevToken = process.env.DAEMON_BOOTSTRAP_TOKEN;

  beforeEach(() => {
    vi.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
    vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    redis = new InMemoryRedisStream();
    registry = new SandboxRegistry();
    provisioner = new CredentialProvisionerService(
      redis,
      registry,
      makeProjects(),
      makeTokens(),
    );
    process.env.WORKSPACE_ID = WORKSPACE_ID;
  });

  afterEach(async () => {
    await provisioner.onApplicationShutdown();
    if (prevWorkspaceId === undefined) delete process.env.WORKSPACE_ID;
    else process.env.WORKSPACE_ID = prevWorkspaceId;
    if (prevToken === undefined) delete process.env.DAEMON_BOOTSTRAP_TOKEN;
    else process.env.DAEMON_BOOTSTRAP_TOKEN = prevToken;
  });

  it('round-trips a valid request → resolved token + author identity', async () => {
    seedSandbox(registry);
    await provisioner.watch(WORKSPACE_ID);

    process.env.DAEMON_BOOTSTRAP_TOKEN = ISSUED_TOKEN;
    const daemonProvider = new RedisGitCredentialProvider(redis);

    const cred = await daemonProvider.resolve();
    expect(cred).toEqual({
      token: GH_TOKEN,
      authorName: 'Agent',
      authorEmail: 'agent@agents.noreply',
    });
  });

  it('caches the credential — a second resolve does not re-pull', async () => {
    seedSandbox(registry);
    await provisioner.watch(WORKSPACE_ID);
    process.env.DAEMON_BOOTSTRAP_TOKEN = ISSUED_TOKEN;
    const daemonProvider = new RedisGitCredentialProvider(redis);

    await daemonProvider.resolve();
    // Now break the host so a re-pull WOULD fail — the cache must serve instead.
    registry.clear();
    const second = await daemonProvider.resolve();
    expect(second.token).toBe(GH_TOKEN);
  });

  it('rejects a BAD bootstrap token (no credential leaks)', async () => {
    seedSandbox(registry);
    await provisioner.watch(WORKSPACE_ID);

    process.env.DAEMON_BOOTSTRAP_TOKEN = 'WRONG-token';
    const daemonProvider = new RedisGitCredentialProvider(redis);

    await expect(daemonProvider.resolve()).rejects.toThrow(
      /host refused git credential: bootstrap token mismatch/,
    );
  });

  it('rejects when the workspace has no issued token (adopted sandbox)', async () => {
    seedSandbox(registry, { bootstrapToken: undefined });
    await provisioner.watch(WORKSPACE_ID);

    process.env.DAEMON_BOOTSTRAP_TOKEN = ISSUED_TOKEN;
    const daemonProvider = new RedisGitCredentialProvider(redis);

    await expect(daemonProvider.resolve()).rejects.toThrow(
      /no bootstrap token issued/,
    );
  });

  it('serves an EMPTY-token credential when no GitHub token resolves (public-repo tolerance)', async () => {
    // No resolvable token is NOT a failure: a public repo clones/fetches with no auth header. The host
    // serves `{token:''}` so the daemon's `gitAuthEnv` yields {} and an unauthenticated clone proceeds.
    seedSandbox(registry);
    provisioner = new CredentialProvisionerService(
      redis,
      registry,
      makeProjects(),
      { resolve: vi.fn(async () => undefined) } as unknown as GithubTokenStore,
    );
    await provisioner.watch(WORKSPACE_ID);

    process.env.DAEMON_BOOTSTRAP_TOKEN = ISSUED_TOKEN;
    const daemonProvider = new RedisGitCredentialProvider(redis);

    const cred = await daemonProvider.resolve();
    expect(cred).toEqual({
      token: '',
      authorName: 'Agent',
      authorEmail: 'agent@agents.noreply',
    });
  });
});
