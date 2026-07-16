import { describe, expect, it } from 'vitest';
import {
  BRIDGE_SERVER_NAME,
  buildBridgeClaudeOptions,
  qualifyBridgeToolNames,
} from './bridge-options';

describe('bridge-options', () => {
  it('qualifies tool names as mcp__<server>__<tool>', () => {
    expect(qualifyBridgeToolNames(['submit_plan', 'recall'])).toEqual([
      'mcp__atlas-host-bridge__submit_plan',
      'mcp__atlas-host-bridge__recall',
    ]);
  });

  it('wraps the server under the `mcpServers` option (NOT a stray top-level key)', () => {
    const server = { __fake: 'mcp-server' };
    const { extraClaudeOptions, bridgeToolNames } = buildBridgeClaudeOptions(
      server,
      ['submit_plan', 'get_pipeline_state'],
    );

    // Regression guard: the server must live under `mcpServers` keyed by the server name — NOT be
    // spread as a top-level `extraClaudeOptions[BRIDGE_SERVER_NAME]` (the original bug), which the
    // SDK would ignore so no orchestration tools ever register.
    expect(Object.keys(extraClaudeOptions)).toEqual(['mcpServers']);
    expect(extraClaudeOptions.mcpServers[BRIDGE_SERVER_NAME]).toBe(server);
    expect(extraClaudeOptions).not.toHaveProperty(BRIDGE_SERVER_NAME);

    expect(bridgeToolNames).toEqual([
      'mcp__atlas-host-bridge__submit_plan',
      'mcp__atlas-host-bridge__get_pipeline_state',
    ]);
  });
});
