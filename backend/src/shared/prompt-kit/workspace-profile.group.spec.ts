import { describe, expect, it } from 'vitest';
import { Agent } from './system/agent';
import { renderAgentPrompt } from './system/assemble';

/**
 * The unified WORKSPACE PROFILE group — the one named area (secrets, mounts, caches, setup, MCP, skills,
 * house style) Atlas keeps current. The overview must appear for the brain in BOTH framings (onboarding =
 * bulk pass, normal = incremental upkeep), name every dimension, and print the live snapshot from
 * `ctx.settings.workspaceProfile`.
 */
const NAME_MARKER = 'THE WORKSPACE PROFILE';
const SNAPSHOT = '- Mounts: .cache (shared-rw)\n- Skills: migrations [repo]';

describe('workspace-profile.group — the named provisioning umbrella', () => {
  it.each(['feature', 'onboarding'] as const)(
    'names the area + lists all seven upkeep tools for jobKind=%s',
    (jobKind) => {
      const out = renderAgentPrompt(Agent.ATLAS_MAIN, { jobKind });
      expect(out).toContain(NAME_MARKER);
      // Each dimension's upkeep tool is named so the brain knows how to maintain it.
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
      const out = renderAgentPrompt(Agent.ATLAS_MAIN, {
        jobKind,
        settings: { workspaceProfile: SNAPSHOT },
      });
      expect(out).toContain('CURRENT WORKSPACE PROFILE');
      expect(out).toContain('migrations [repo]');
    },
  );

  it('says "nothing recorded yet" when the snapshot is empty', () => {
    const out = renderAgentPrompt(Agent.ATLAS_MAIN, { jobKind: 'feature' });
    expect(out).toContain('nothing recorded yet');
  });

  it('frames onboarding as the bulk pass and a normal job as incremental upkeep', () => {
    const onboarding = renderAgentPrompt(Agent.ATLAS_MAIN, {
      jobKind: 'onboarding',
    });
    const normal = renderAgentPrompt(Agent.ATLAS_MAIN, { jobKind: 'feature' });
    expect(onboarding).toContain('FIRST, BULK pass');
    expect(normal).toContain('KEEPING IT CURRENT IS YOUR JOB TOO');
  });

  it('surfaces org vs repo scope for skills + MCP in a NORMAL job (not just onboarding)', () => {
    const normal = renderAgentPrompt(Agent.ATLAS_MAIN, { jobKind: 'feature' });
    expect(normal).toContain(
      'the skill tools (propose_skill_install / propose_skill / propose_skill_removal)',
    );
    expect(normal).toContain('propose_mcp_servers each take scope:"repo"');
    expect(normal).toContain('scope:"org"');
    // The anti-pattern the fix targets: a normal job must not be steered to decline org-wide requests.
    expect(normal).toContain('never decline an org-wide request');
  });
});
