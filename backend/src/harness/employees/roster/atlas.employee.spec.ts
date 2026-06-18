import { describe, expect, it } from 'vitest';
import { AtlasEmployee } from './atlas.employee';
import { MarkPrReadyTool } from '../../tools/workspaces/mark-pr-ready.tool';
import { OpenPrTool } from '../../tools/workspaces/open-pr.tool';

/**
 * Atlas spreads DEFAULT_CHAT_TOOLSET and then adds lead-only tools. The allowlist→tools mapping does
 * NOT dedup (tool.registry.ts), so a tool listed in BOTH the spread and the explicit additions would
 * register twice and hand the model a duplicate-named tool. mark_pr_ready moved into the default
 * toolset (every owner ships their own PR), so re-listing it on Atlas is the regression to guard.
 */
describe('Atlas roster tools', () => {
  const tools = new AtlasEmployee().tools ?? [];

  it('registers every tool class at most once (no double-registration)', () => {
    expect(new Set(tools).size).toBe(tools.length);
  });

  it('inherits mark_pr_ready from the default toolset (not a second explicit copy)', () => {
    expect(tools.filter((t) => t === MarkPrReadyTool)).toHaveLength(1);
  });

  it('keeps open_pr as a lead-only explicit addition', () => {
    expect(tools).toContain(OpenPrTool);
  });
});
