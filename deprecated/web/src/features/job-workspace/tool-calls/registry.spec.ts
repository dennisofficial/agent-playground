import { describe, expect, it } from 'vitest';
import { mcpBridgeHandler } from './handlers/mcp-bridge';
import { nativeMiscHandler } from './handlers/native-misc';
import { resolveHandler } from './registry';

/**
 * Regression guard: the unified `task_*` host-bridge tools must render as task cards
 * (`nativeMiscHandler`), not fall through to the generic blue `mcp · task_create` bridge row
 * (`mcpBridgeHandler`) — `nativeMiscHandler` is ordered before `mcpBridgeHandler` in the registry, but
 * only matches if it strips the `mcp__atlas-host-bridge__` prefix first.
 */
describe('resolveHandler — unified task tools', () => {
  it.each([
    'mcp__atlas-host-bridge__task_create',
    'mcp__atlas-host-bridge__task_update',
    'mcp__atlas-host-bridge__task_list',
    'mcp__atlas-host-bridge__task_get',
  ])('routes %s to nativeMiscHandler, not mcpBridgeHandler', (name) => {
    const handler = resolveHandler(name, {});
    expect(handler).toBe(nativeMiscHandler);
    expect(handler).not.toBe(mcpBridgeHandler);
  });

  it('still routes other bridge tools to mcpBridgeHandler', () => {
    expect(resolveHandler('mcp__atlas-host-bridge__ask_question', {})).toBe(mcpBridgeHandler);
  });

  it('still routes the bare subagent-spawning Task tool to nativeMiscHandler', () => {
    expect(resolveHandler('Task', {})).toBe(nativeMiscHandler);
  });
});
