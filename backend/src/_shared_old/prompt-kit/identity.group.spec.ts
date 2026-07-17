import { describe, expect, it } from 'vitest';
import { Agent } from './system/agent';
import { renderAgentPrompt } from './system/assemble';

const HEADER = 'CURRENT JOB';

describe('identity.group — CURRENT JOB orientation block', () => {
  it('renders repo and branch·base for the build brain', () => {
    const out = renderAgentPrompt(Agent.PLANNING, {
      jobKind: 'feature',
      job: { repoName: 'acme/widgets', branch: 'feat/x', baseBranch: 'main' },
    });
    expect(out).toContain(HEADER);
    expect(out).toContain('- Repo: acme/widgets');
    expect(out).toContain('- Branch: feat/x  ·  Base: main');
  });

  it('renders the current Title (so the brain can judge a propose_plan rename)', () => {
    const out = renderAgentPrompt(Agent.PLANNING, {
      jobKind: 'feature',
      job: {
        repoName: 'acme/widgets',
        title: 'Rework the billing webhook',
        baseBranch: 'main',
      },
    });
    expect(out).toContain('- Title: Rework the billing webhook');
  });

  it('omits the Title line when the job has no title yet', () => {
    const out = renderAgentPrompt(Agent.PLANNING, {
      jobKind: 'feature',
      job: { repoName: 'acme/widgets', baseBranch: 'main' },
    });
    expect(out).toContain(HEADER);
    expect(out).not.toContain('- Title:');
  });

  it('never renders a Working directory line (owned by the FILESYSTEM MAP fragment)', () => {
    const out = renderAgentPrompt(Agent.PLANNING, {
      jobKind: 'feature',
      job: { repoName: 'acme/widgets', branch: 'feat/x', baseBranch: 'main' },
    });
    expect(out).not.toContain('- Working directory:');
  });

  it('collapses to a single Base line when no feature branch is cut yet', () => {
    const out = renderAgentPrompt(Agent.PLANNING, {
      jobKind: 'feature',
      job: { repoName: 'acme/widgets', baseBranch: 'main' },
    });
    expect(out).toContain('- Base branch: main');
    expect(out).not.toContain('- Branch:');
  });

  it('emits NOTHING (byte-identical) when no job ctx is supplied', () => {
    const baseline = renderAgentPrompt(Agent.PLANNING, {
      jobKind: 'feature',
    });
    expect(baseline).not.toContain(HEADER);
    const out = renderAgentPrompt(Agent.PLANNING, {
      jobKind: 'feature',
      job: null,
    });
    expect(out).toBe(baseline);
  });

  it('is withheld from review jobs (build-brain only)', () => {
    const out = renderAgentPrompt(Agent.PLANNING, {
      jobKind: 'review',
      job: { repoName: 'acme/widgets' },
    });
    expect(out).not.toContain(HEADER);
  });

  it('never reaches a worker agent, even with a job ctx', () => {
    const out = renderAgentPrompt(Agent.WORKER, {
      job: { repoName: 'acme/widgets', baseBranch: 'main' },
    });
    expect(out).not.toContain(HEADER);
  });
});
