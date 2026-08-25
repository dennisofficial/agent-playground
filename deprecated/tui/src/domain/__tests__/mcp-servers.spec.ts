import { describe, expect, it } from 'bun:test';
import { mcpServerNotices } from '../mcp-servers.js';

/**
 * A broken MCP server is invisible by nature: it produces no tools, and no tool call fails. The
 * roster in the `init` frame is the only place it is ever mentioned, so this is the rule for which
 * of those rows is worth a row in the transcript.
 */
describe('mcpServerNotices', () => {
  it('says nothing about servers that are working or on their way', () => {
    expect(
      mcpServerNotices([
        { name: 'atlas', status: 'connected' },
        { name: 'trigger', status: 'pending' },
        { name: 'linear', status: 'connecting' },
      ]),
    ).toEqual([]);
  });

  /** Somebody chose that, in `.claude/settings.local.json`. Honouring a choice is not news. */
  it('says nothing about a server the human disabled', () => {
    expect(mcpServerNotices([{ name: 'trigger', status: 'disabled' }])).toEqual([]);
  });

  it('names a failed server and says its tools are missing', () => {
    const [notice] = mcpServerNotices([{ name: 'trigger', status: 'failed' }]);

    expect(notice?.text).toContain('trigger');
    expect(notice?.text).toContain('failed');
    expect(notice?.text).toContain('not in this thread');
  });

  /** The one status with a next step — and it is a step only the human can take. */
  it('tells the human where to authenticate one that needs it', () => {
    const [notice] = mcpServerNotices([{ name: 'notion', status: 'needs-auth' }]);

    expect(notice?.text).toContain('claude');
    expect(notice?.text).toMatch(/authenticate/i);
  });

  it('keeps the roster order, and reports every troubled server', () => {
    expect(
      mcpServerNotices([
        { name: 'a', status: 'failed' },
        { name: 'b', status: 'connected' },
        { name: 'c', status: 'needs-auth' },
      ]),
    ).toHaveLength(2);
  });

  /**
   * The key is what stops one broken server writing a row per turn — and what lets the SAME server
   * speak again when what is wrong with it changes.
   */
  it('keys a notice by server AND status', () => {
    const key = (status: string): string | undefined =>
      mcpServerNotices([{ name: 'trigger', status }])[0]?.key;

    expect(key('failed')).toBeDefined();
    expect(key('failed')).not.toBe(key('needs-auth'));
    expect(key('failed')).toBe(key('failed'));
  });
});
