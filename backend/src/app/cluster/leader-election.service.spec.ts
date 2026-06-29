import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import type { EnvService } from '@core/config/env/env.service';

// Shared, test-controllable lock state + a record of every mock pg.Client built.
const h = vi.hoisted(() => ({
  grant: true,
  clients: [] as Array<{ queries: string[]; ended: boolean }>,
}));

vi.mock('pg', () => {
  class Client {
    queries: string[] = [];
    ended = false;
    constructor() {
      h.clients.push(this);
    }
    on(): this {
      return this;
    }
    async connect(): Promise<void> {}
    async query(sql: string): Promise<{ rows: unknown[] }> {
      this.queries.push(sql);
      if (sql.includes('pg_try_advisory_lock')) return { rows: [{ locked: h.grant }] };
      if (sql.includes('pg_advisory_unlock')) return { rows: [{ pg_advisory_unlock: true }] };
      return { rows: [] };
    }
    async end(): Promise<void> {
      this.ended = true;
    }
  }
  return { default: { Client }, Client };
});

// Imported AFTER the mock is registered.
const { LeaderElectionService } = await import('./leader-election.service');

function envMock(overrides: Record<string, unknown> = {}): EnvService {
  const values: Record<string, unknown> = {
    POSTGRES_DB: 'atlas', // NOT *_test → exercises the real election path
    POSTGRES_USER: 'u',
    POSTGRES_PASSWORD: 'p',
    POSTGRES_HOST: 'h',
    POSTGRES_PORT: 5432,
    LEADER_POLL_INTERVAL_MS: 2000,
    ...overrides,
  };
  return { get: (k: string) => values[k] } as unknown as EnvService;
}

describe('LeaderElectionService', () => {
  beforeEach(() => {
    h.grant = true;
    h.clients = [];
  });
  afterEach(async () => {
    vi.useRealTimers();
  });

  it('acquires the lock on boot → becomes leader and fires onPromote', async () => {
    const svc = new LeaderElectionService(envMock());
    const promoted = vi.fn();
    svc.onPromote(promoted);
    await svc.onApplicationBootstrap();
    expect(svc.isLeader()).toBe(true);
    expect(svc.getState()).toBe('leader');
    expect(promoted).toHaveBeenCalledTimes(1);
    await svc.onApplicationShutdown();
  });

  it('fires onPromote IMMEDIATELY when registered after already-leader (boot-order safe)', async () => {
    const svc = new LeaderElectionService(envMock());
    await svc.onApplicationBootstrap();
    const late = vi.fn();
    svc.onPromote(late); // subscribes after promotion already happened
    expect(late).toHaveBeenCalledTimes(1);
    await svc.onApplicationShutdown();
  });

  it('stays a follower (not ready) when the lock is held elsewhere', async () => {
    vi.useFakeTimers();
    h.grant = false;
    const svc = new LeaderElectionService(envMock());
    const promoted = vi.fn();
    svc.onPromote(promoted);
    await svc.onApplicationBootstrap();
    expect(svc.isLeader()).toBe(false);
    expect(svc.getState()).toBe('follower');
    expect(promoted).not.toHaveBeenCalled();
    await svc.onApplicationShutdown();
  });

  it('beginDrain demotes (ready=false) but KEEPS the lock until releaseLeadership', async () => {
    const svc = new LeaderElectionService(envMock());
    const demoted = vi.fn();
    svc.onDemote(demoted);
    await svc.onApplicationBootstrap();
    expect(svc.isLeader()).toBe(true);

    svc.beginDrain();
    expect(svc.getState()).toBe('draining');
    expect(svc.isLeader()).toBe(false); // /health/ready → 503
    expect(demoted).toHaveBeenCalledTimes(1); // reaper + realtime stop
    const client = h.clients[0];
    expect(client.queries.some((q) => q.includes('pg_advisory_unlock'))).toBe(false); // lock still held

    await svc.releaseLeadership();
    expect(client.queries.some((q) => q.includes('pg_advisory_unlock'))).toBe(true); // now released
    await svc.onApplicationShutdown();
  });

  it('is the implicit leader on a *_test database (no real lock taken)', async () => {
    const svc = new LeaderElectionService(envMock({ POSTGRES_DB: 'agent_playground_test' }));
    await svc.onApplicationBootstrap();
    expect(svc.isLeader()).toBe(true);
    expect(h.clients).toHaveLength(0); // never opened a pg connection
    await svc.onApplicationShutdown();
  });
});
