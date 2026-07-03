import { describe, expect, it, vi } from 'vitest';
import type { Repository } from 'typeorm';
import type { CredentialResolver } from '../onboarding';
import type { GithubPrService, CheckRun, PullDetail } from '../git';
import type { StimulusIntake } from '../stimulus';
import type { JobEntity, RepoEntity } from '../persistence/entities';
import { GitStateReconciler, summarizeChecks } from './git-state-reconciler.service';

function make(over: {
  detail: PullDetail;
  runs?: CheckRun[];
  job?: Partial<JobEntity>;
}) {
  const job = {
    id: 'job-1',
    org_id: 'T1',
    repo_id: 'repo-1',
    pr_number: 7,
    ci_status: null,
    pr_mergeable: null,
    ...over.job,
  } as JobEntity;
  const update = vi.fn(async () => ({}));
  const intakeEvent = vi.fn(async () => ({ admitted: true, stimulusId: 's', jobId: job.id }));
  const jobs = { find: vi.fn(async () => [job]), update } as unknown as Repository<JobEntity>;
  const repos = {
    findOne: vi.fn(async () => ({ git_url: 'https://github.com/acme/web.git' })),
  } as unknown as Repository<RepoEntity>;
  const pr = {
    getPullDetail: vi.fn(async () => over.detail),
    listCheckRuns: vi.fn(async () => over.runs ?? []),
  } as unknown as GithubPrService;
  const creds = { githubToken: vi.fn(async () => 'tok') } as unknown as CredentialResolver;
  const intake = { intakeEvent } as unknown as StimulusIntake;
  const svc = new GitStateReconciler(jobs, repos, pr, creds, intake);
  return { svc, job, update, intakeEvent, pr };
}

function detail(over: Partial<PullDetail> = {}): PullDetail {
  return { number: 7, url: 'http://pr/7', state: 'open', mergeableState: 'clean', headSha: 'abc', headRef: 'feat/x', ...over };
}

describe('GitStateReconciler.reconcile', () => {
  it('routes a merge conflict (dirty) to the owning job via intakeEvent + updates columns', async () => {
    const { svc, update, intakeEvent } = make({ detail: detail({ mergeableState: 'dirty' }) });
    await svc.reconcile();
    expect(intakeEvent).toHaveBeenCalledOnce();
    expect(intakeEvent.mock.calls[0][0]).toMatchObject({
      source: 'github',
      dedupeKey: 'conflict:7:abc',
      severity: 'critical',
      correlation: { prNumber: 7 },
    });
    expect(update).toHaveBeenCalledWith({ id: 'job-1' }, { ci_status: null, pr_mergeable: 'dirty' });
  });

  it('clean mergeable → no conflict routed, only column refresh', async () => {
    const { svc, intakeEvent, update } = make({
      detail: detail({ mergeableState: 'clean' }),
      runs: [{ id: 1, name: 'CI', status: 'completed', conclusion: 'success', detailsUrl: null }],
    });
    await svc.reconcile();
    expect(intakeEvent).not.toHaveBeenCalled();
    expect(update).toHaveBeenCalledWith({ id: 'job-1' }, { ci_status: 'success', pr_mergeable: 'clean' });
  });

  it('null mergeable_state (GitHub still computing) → does NOT route a conflict', async () => {
    const { svc, intakeEvent } = make({ detail: detail({ mergeableState: null }) });
    await svc.reconcile();
    expect(intakeEvent).not.toHaveBeenCalled();
  });

  it('merged/closed PR → skips entirely (pollPrClosures owns teardown)', async () => {
    const { svc, intakeEvent, update, pr } = make({ detail: detail({ state: 'merged' }) });
    await svc.reconcile();
    expect(intakeEvent).not.toHaveBeenCalled();
    expect(update).not.toHaveBeenCalled();
    expect(pr.listCheckRuns).not.toHaveBeenCalled();
  });

  it('no column write when nothing changed (avoids realtime churn)', async () => {
    const { svc, update } = make({
      detail: detail({ mergeableState: 'clean' }),
      job: { ci_status: 'success', pr_mergeable: 'clean' },
      runs: [{ id: 1, name: 'CI', status: 'completed', conclusion: 'success', detailsUrl: null }],
    });
    await svc.reconcile();
    expect(update).not.toHaveBeenCalled();
  });
});

describe('summarizeChecks', () => {
  const run = (conclusion: string | null, status = 'completed'): CheckRun => ({ id: 1, name: 'x', status, conclusion, detailsUrl: null });
  it('null when no checks', () => expect(summarizeChecks([])).toBeNull());
  it('failure when any completed run failed', () =>
    expect(summarizeChecks([run('success'), run('failure')])).toBe('failure'));
  it('success when all completed and none failed', () =>
    expect(summarizeChecks([run('success'), run('neutral')])).toBe('success'));
  it('pending when a run is still running', () =>
    expect(summarizeChecks([run('success'), run(null, 'in_progress')])).toBe('pending'));
});
