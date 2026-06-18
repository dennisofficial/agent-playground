import { z } from 'zod';
import { WorkspaceGitProvider } from '../../workspaces/workspace-git.provider';
import { HarnessTool } from '../harness-tool.decorator';
import type { IHarnessTool } from '../tool.types';

const openPrSchema = z.object({
  workspaceId: z
    .string()
    .describe('The workspace whose shared branch the PR is for.'),
  title: z.string().describe('PR title.'),
  body: z.string().optional().describe('PR description (markdown).'),
});

/**
 * The end of a feature's life: push the shared integration branch to the project's registered GitHub
 * repo and open (or find) the pull request Dennis reviews. The work area lives inside the daemon, which
 * owns the repo + token + push + PR — so this dispatches to the daemon RPC; the token never touches the
 * host or any return path.
 */
@HarnessTool()
export class OpenPrTool implements IHarnessTool<typeof openPrSchema> {
  readonly name = 'open_pr';
  readonly description =
    "Open (or find) the pull request for a feature's shared branch on the project's registered GitHub repo — as a DRAFT, so it doesn't read as ready while you're still working. Returns the PR URL to relay. Call it ONCE per feature: publish_workspace keeps the shared branch synced, so later publishes update the open PR by themselves. When the work is done and you want Dennis to review, mark_pr_ready flips it out of draft.";
  readonly schema = openPrSchema;

  constructor(private readonly workspaceGit: WorkspaceGitProvider) {}

  async execute({
    workspaceId,
    title,
    body,
  }: z.infer<typeof openPrSchema>): Promise<string> {
    // The daemon owns the repo + token + push + PR (the host has no workspace row). Open (or find) the
    // DRAFT PR over the daemon RPC; it resolves repo/token itself.
    const daemon = this.workspaceGit.daemonFor({ workspaceId });
    if (!daemon) return `No live sandbox for ${workspaceId} — can't open the PR.`;
    try {
      const pr = await daemon.openPr({ title, body, draft: true });
      return pr.existing
        ? `A PR for this workspace's shared branch already exists: ${pr.url}`
        : `Opened DRAFT PR: ${pr.url} — mark_pr_ready when it's ready for Dennis.`;
    } catch (err) {
      return `Couldn't open the PR: ${err instanceof Error ? err.message : String(err)}`;
    }
  }
}
