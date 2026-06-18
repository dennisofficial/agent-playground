import { describe, expect, it, vi } from 'vitest';
import type { WorkspaceGitProvider } from '../../workspaces/workspace-git.provider';
import { OpenPrTool } from './open-pr.tool';

/**
 * open_pr is daemon-only: the work area lives inside the sandbox, which owns the repo + token + push +
 * PR. The tool resolves the daemon adapter via `WorkspaceGitProvider.daemonFor` and dispatches `openPr`.
 */
describe('open_pr tool (daemon-only)', () => {
  it('opens the DRAFT PR via the daemon', async () => {
    const openPr = vi.fn(async () => ({
      url: 'https://github.com/dennis/proj/pull/9',
      number: 9,
      existing: false,
    }));
    const daemon = { openPr };
    const workspaceGit = {
      daemonFor: () => daemon,
    } as unknown as WorkspaceGitProvider;
    const tool = new OpenPrTool(workspaceGit);

    const out = await tool.execute({
      workspaceId: 'wa-1',
      title: 'Feature',
      body: 'desc',
    });
    expect(openPr).toHaveBeenCalledWith({
      title: 'Feature',
      body: 'desc',
      draft: true,
    });
    expect(out).toContain('Opened DRAFT PR: https://github.com/dennis/proj/pull/9');
  });

  it('reports an existing PR with the existing wording', async () => {
    const daemon = {
      openPr: vi.fn(async () => ({
        url: 'https://github.com/dennis/proj/pull/3',
        number: 3,
        existing: true,
      })),
    };
    const tool = new OpenPrTool({
      daemonFor: () => daemon,
    } as unknown as WorkspaceGitProvider);
    const out = await tool.execute({ workspaceId: 'wa-1', title: 'T' });
    expect(out).toContain(
      'shared branch already exists: https://github.com/dennis/proj/pull/3',
    );
  });

  it('refuses when the work area has no live sandbox', async () => {
    const tool = new OpenPrTool({
      daemonFor: () => undefined,
    } as unknown as WorkspaceGitProvider);
    const out = await tool.execute({ workspaceId: 'wa-gone', title: 'T' });
    expect(out).toContain('No live sandbox for wa-gone');
  });
});
