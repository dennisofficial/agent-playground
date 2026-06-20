import { beforeEach, describe, expect, it } from 'vitest';
import type { EnvService } from '@core/config/env/env.service';
import type { Repository } from 'typeorm';
import type { EngineRunner } from '../engine';
import type { RunEngineArgs } from '../engine';
import type { LocalGitService, ProjectRepo } from '../git';
import type { AtlasProject } from '../persistence/entities';
import { ScopingInvestigatorService } from './scoping-investigator.service';

/** A fake EngineRunner that records calls and returns canned read-only output. */
function fakeEngine(): EngineRunner & { runs: RunEngineArgs[] } {
  const runs: RunEngineArgs[] = [];
  return {
    runs,
    async run(args: RunEngineArgs) {
      runs.push(args);
      return args.mode === 'plan'
        ? { result: 'plan summary', planText: 'PLAN: digest from plan mode', sessionId: 's' }
        : { result: 'INVESTIGATE: digest from read-only mode', sessionId: 's' };
    },
  } as unknown as EngineRunner & { runs: RunEngineArgs[] };
}

function throwingEngine(): EngineRunner {
  return {
    async run() {
      throw new Error('engine boom');
    },
  } as unknown as EngineRunner;
}

function fakeGit(): LocalGitService {
  return {
    async ensureRepo(input: { projectId: string; gitUrl: string; defaultBranch?: string }) {
      return {
        projectId: input.projectId,
        gitUrl: input.gitUrl,
        defaultBranch: input.defaultBranch ?? 'main',
        repoPath: `/tmp/fake/${input.projectId}`,
      } satisfies ProjectRepo;
    },
  } as unknown as LocalGitService;
}

function fakeProjects(row: Partial<AtlasProject> | null): Repository<AtlasProject> {
  return {
    async findOne() {
      return row as AtlasProject | null;
    },
  } as unknown as Repository<AtlasProject>;
}

function fakeEnv(map: Record<string, string | undefined> = {}): EnvService {
  return { get: (k: string) => map[k] } as unknown as EnvService;
}

const PROJECT = { git_url: 'https://github.com/acme/repo', default_branch: 'main' };
const INPUT = { teamId: 'T1', projectId: 'p1', threadId: 'thr-1', focus: 'add rate limiting' };

describe('ScopingInvestigatorService', () => {
  let engine: ReturnType<typeof fakeEngine>;

  beforeEach(() => {
    engine = fakeEngine();
  });

  it('runs a strict read-only "investigate" turn by default and returns the digest', async () => {
    const svc = new ScopingInvestigatorService(
      fakeEnv(),
      engine,
      fakeGit(),
      fakeProjects(PROJECT),
    );
    const digest = await svc.digest(INPUT);
    expect(digest).toContain('digest from read-only mode');
    expect(engine.runs).toHaveLength(1);
    expect(engine.runs[0].mode).toBe('investigate');
    expect(engine.runs[0].cwd).toBe('/tmp/fake/p1');
  });

  it('uses native plan mode (planText) when ATLAS_SCOPING_MODE=native_plan', async () => {
    const svc = new ScopingInvestigatorService(
      fakeEnv({ ATLAS_SCOPING_MODE: 'native_plan' }),
      engine,
      fakeGit(),
      fakeProjects(PROJECT),
    );
    const digest = await svc.digest(INPUT);
    expect(digest).toBe('PLAN: digest from plan mode');
    expect(engine.runs[0].mode).toBe('plan');
  });

  it('caches the digest per thread (second call does not re-investigate)', async () => {
    const svc = new ScopingInvestigatorService(
      fakeEnv(),
      engine,
      fakeGit(),
      fakeProjects(PROJECT),
    );
    await svc.digest(INPUT);
    await svc.digest(INPUT);
    expect(engine.runs).toHaveLength(1);
    // forget() drops the cache → re-investigates.
    svc.forget(INPUT.threadId);
    await svc.digest(INPUT);
    expect(engine.runs).toHaveLength(2);
  });

  it('returns "" without calling the engine when there is no project repo', async () => {
    const svc = new ScopingInvestigatorService(
      fakeEnv(),
      engine,
      fakeGit(),
      fakeProjects(null),
    );
    expect(await svc.digest(INPUT)).toBe('');
    expect(engine.runs).toHaveLength(0);
  });

  it('fails soft to "" when the investigation throws', async () => {
    const svc = new ScopingInvestigatorService(
      fakeEnv(),
      throwingEngine(),
      fakeGit(),
      fakeProjects(PROJECT),
    );
    expect(await svc.digest(INPUT)).toBe('');
  });
});
