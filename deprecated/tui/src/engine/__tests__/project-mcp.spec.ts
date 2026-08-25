import { describe, expect, it } from 'bun:test';
import { claudeOptions } from '../claude-options.js';

/**
 * A repository configured for `claude` is configured for Atlas.
 *
 * The servers in a repo's checked-in `.mcp.json` arrive UNAPPROVED: Claude Code asks a human once
 * and writes the answer into `.claude/settings.local.json`. An SDK session has nobody to ask, so
 * without a blanket approval the server is listed in the `init` frame as `pending` forever and its
 * tools never reach the model — which is silent, because a tool that was never there cannot fail.
 * MEASURED on comp-v3, whose `trigger` server sat pending through a whole job.
 */

const RUN = {
  prompt: 'hello',
  cwd: '/repo',
  model: 'claude-opus-5',
  env: {},
  onEvent: (): void => undefined,
};

/** The option is a JSON STRING, not an object — see the note on `settings` in `claude-options.ts`. */
function settingsOf(options: ReturnType<typeof claudeOptions>): Record<string, unknown> {
  expect(typeof options.settings).toBe('string');
  return JSON.parse(String(options.settings)) as Record<string, unknown>;
}

describe('the repository’s own MCP servers', () => {
  it('approves every server the project declares', () => {
    expect(settingsOf(claudeOptions(RUN)).enableAllProjectMcpServers).toBe(true);
  });

  it('keeps the settings Atlas already owned, and stays a JSON string', () => {
    const settings = settingsOf(claudeOptions({ ...RUN, fastMode: true }));

    // Rotation owns context, so SDK auto-compaction stays off whatever else lands in here.
    expect(settings.autoCompactEnabled).toBe(false);
    expect(settings.fastMode).toBe(true);
  });

  /**
   * `local` is `.claude/settings.local.json` — gitignored, per-machine, and where a human's own
   * `enabledMcpjsonServers` / `disabledMcpjsonServers` decisions are recorded. Loading it is how a
   * server the human deliberately turned off in that repository stays off here too.
   */
  it('reads every setting source Claude Code itself would in that directory', () => {
    expect(claudeOptions(RUN).settingSources).toEqual(['user', 'project', 'local']);
  });

  /**
   * `tools` restricts the BUILT-IN kit and nothing else — the SDK's own doc string says so, and
   * `mcp__atlas__*` reaching the model while `tools` held only native names is the proof. A guard,
   * because "MCP tools are missing" would be the first suspicion if this ever changed.
   */
  it('does not list MCP tools in the native allowlist — that lever is not about them', () => {
    const tools = claudeOptions(RUN).tools;

    expect(Array.isArray(tools)).toBe(true);
    expect((tools as string[]).some((tool) => tool.startsWith('mcp__'))).toBe(false);
  });
});
