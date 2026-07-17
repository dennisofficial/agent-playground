import { describe, expect, it } from 'vitest';
import {
  WORKSPACE_PROFILE_BRIDGE_NAME,
  WORKSPACE_PROFILE_TOOL_NAMES,
  partitionWorkspaceProfileTools,
  qualifyWorkspaceProfileToolNames,
} from './workspace-profile-bridge-options';

describe('workspace-profile-bridge-options', () => {
  it('qualifies tool names as mcp__workspace-profile__<tool>', () => {
    expect(qualifyWorkspaceProfileToolNames(['request_secret', 'write_workspace_config'])).toEqual([
      'mcp__workspace-profile__request_secret',
      'mcp__workspace-profile__write_workspace_config',
    ]);
    expect(WORKSPACE_PROFILE_BRIDGE_NAME).toBe('workspace-profile');
  });

  it('partitions a flat host tool list into host vs profile, preserving order', () => {
    const all = [
      'ask_question',
      'request_secret',
      'propose_plan',
      'write_workspace_config',
      'reset_sandbox',
      'propose_mcp_servers',
    ];
    const { host, profile } = partitionWorkspaceProfileTools(all);
    // reset_sandbox is generic sandbox control — stays on the host bridge, NOT the profile bridge.
    expect(host).toEqual(['ask_question', 'propose_plan', 'reset_sandbox']);
    expect(profile).toEqual(['request_secret', 'write_workspace_config', 'propose_mcp_servers']);
  });

  it('routes reset_sandbox to the host bridge (it is not a profile dimension)', () => {
    expect(WORKSPACE_PROFILE_TOOL_NAMES).not.toContain('reset_sandbox');
  });

  it('renamed write_workspace_config is on the profile bridge; the old worktree name is gone', () => {
    expect(WORKSPACE_PROFILE_TOOL_NAMES).toContain('write_workspace_config');
    expect(WORKSPACE_PROFILE_TOOL_NAMES as readonly string[]).not.toContain(
      'write_worktree_config',
    );
  });
});
