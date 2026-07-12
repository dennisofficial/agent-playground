import { describe, expect, it } from 'vitest';
import { Agent } from './system/agent';
import { renderAgentPrompt } from './system/assemble';

/**
 * The CURRENT JOB orientation block (`identity.group.currentJob`) — injects the per-job repo/branch/cwd
 * facts into the build brain when the call site supplies `ctx.job`, and vanishes (byte-identical prompt)
 * when it does not: the no-misfire invariant that keeps subagents + the boot smoke-test probes untouched.
 */
const HEADER = 'CURRENT JOB';

describe('identity.group — CURRENT JOB orientation block', () => {
  it('renders repo, working directory, and branch·base for the build brain', () => {
    const out = renderAgentPrompt(Agent.ATLAS_MAIN, {
      jobKind: 'feature',
      job: { repoName: 'acme/widgets', cwd: '/workspace', branch: 'feat/x', baseBranch: 'main' },
    });
    expect(out).toContain(HEADER);
    expect(out).toContain('- Repo: acme/widgets');
    expect(out).toContain('- Working directory: /workspace');
    expect(out).toContain('- Branch: feat/x  ·  Base: main');
  });

  it('collapses to a single Base line when no feature branch is cut yet', () => {
    const out = renderAgentPrompt(Agent.ATLAS_MAIN, {
      jobKind: 'feature',
      job: { repoName: 'acme/widgets', cwd: '/workspace', baseBranch: 'main' },
    });
    expect(out).toContain('- Base branch: main');
    expect(out).not.toContain('- Branch:');
  });

  it('emits NOTHING (byte-identical) when no job ctx is supplied', () => {
    const baseline = renderAgentPrompt(Agent.ATLAS_MAIN, { jobKind: 'feature' });
    expect(baseline).not.toContain(HEADER);
    // The no-misfire invariant: absent `job` ⇒ exactly today's prompt.
    const out = renderAgentPrompt(Agent.ATLAS_MAIN, { jobKind: 'feature', job: null });
    expect(out).toBe(baseline);
  });

  it('is withheld from review jobs (build-brain only)', () => {
    const out = renderAgentPrompt(Agent.ATLAS_MAIN, {
      jobKind: 'review',
      job: { repoName: 'acme/widgets', cwd: '/workspace' },
    });
    expect(out).not.toContain(HEADER);
  });

  it('never reaches a worker agent, even with a job ctx', () => {
    const out = renderAgentPrompt(Agent.WORKER, {
      job: { repoName: 'acme/widgets', cwd: '/workspace', baseBranch: 'main' },
    });
    expect(out).not.toContain(HEADER);
  });
});
