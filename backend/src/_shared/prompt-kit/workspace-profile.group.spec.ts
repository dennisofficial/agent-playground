import { describe, expect, it } from 'vitest';
import { Agent } from './system/agent';
import { renderAgentPrompt } from './system/assemble';

const NAME_MARKER = 'THE WORKSPACE PROFILE';
const SNAPSHOT = '- Mounts: .cache (shared-rw)\n- Skills: migrations [repo]';

describe('workspace-profile.group — the named provisioning umbrella', () => {
  it.each(['feature', 'onboarding'] as const)(
    'names the area + lists all seven upkeep tools for jobKind=%s',
    (jobKind) => {
      const out = renderAgentPrompt(Agent.PLANNING, { jobKind });
      expect(out).toContain(NAME_MARKER);
      for (const tool of [
        'request_secret',
        'write_workspace_config',
        'write_setup_script',
        'propose_mcp_servers',
        'propose_skill',
        'propose_convention_profile',
      ]) {
        expect(out).toContain(tool);
      }
    },
  );

  it.each(['feature', 'onboarding'] as const)(
    'prints the live snapshot when present (jobKind=%s)',
    (jobKind) => {
      const out = renderAgentPrompt(Agent.PLANNING, {
        jobKind,
        settings: { workspaceProfile: SNAPSHOT },
      });
      expect(out).toContain('CURRENT WORKSPACE PROFILE');
      expect(out).toContain('migrations [repo]');
    },
  );

  it('says "nothing recorded yet" when the snapshot is empty', () => {
    const out = renderAgentPrompt(Agent.PLANNING, { jobKind: 'feature' });
    expect(out).toContain('nothing recorded yet');
  });

  it('frames onboarding as the bulk pass and a normal job as incremental upkeep', () => {
    const onboarding = renderAgentPrompt(Agent.PLANNING, {
      jobKind: 'onboarding',
    });
    const normal = renderAgentPrompt(Agent.PLANNING, { jobKind: 'feature' });
    expect(onboarding).toContain('FIRST, BULK pass');
    expect(normal).toContain('KEEPING IT CURRENT IS YOUR JOB TOO');
  });

  it('surfaces org vs repo scope for skills + MCP in a NORMAL job (not just onboarding)', () => {
    const normal = renderAgentPrompt(Agent.PLANNING, { jobKind: 'feature' });
    expect(normal).toContain(
      'the skill tools (propose_skill_install / propose_skill / propose_skill_removal)',
    );
    expect(normal).toContain('propose_mcp_servers each take scope:"repo"');
    expect(normal).toContain('scope:"org"');
    expect(normal).toContain('never decline an org-wide request');
  });
});
