import { z } from 'zod';
import { parseGithubRepo } from '../../projects/git-auth';
import { GithubApiService } from '../../projects/github-api.service';
import { GithubTokenStore } from '../../projects/github-token-store';
import { WorkspaceGitProvider } from '../../workspaces/workspace-git.provider';
import { WorkspaceService } from '../../workspaces/workspace.service';
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
 * The end of a feature's life: push the shared integration branch to the project's registered
 * GitHub repo and open (or find) the pull request Dennis reviews. The token flows into the push
 * env and the Authorization header only — it never appears in any return path.
 */
@HarnessTool()
export class OpenPrTool implements IHarnessTool<typeof openPrSchema> {
  readonly name = 'open_pr';
  readonly description =
    "Open (or find) the pull request for a feature's shared branch on the project's registered GitHub repo — as a DRAFT, so it doesn't read as ready while you're still working. Returns the PR URL to relay. Call it ONCE per feature: publish_workspace keeps the shared branch synced, so later publishes update the open PR by themselves. When the work is done and you want Dennis to review, mark_pr_ready flips it out of draft.";
  readonly schema = openPrSchema;

  constructor(
    private readonly workspaces: WorkspaceService,
    private readonly workspaceGit: WorkspaceGitProvider,
    private readonly tokens: GithubTokenStore,
    private readonly github: GithubApiService,
  ) {}

  async execute({
    workspaceId,
    title,
    body,
  }: z.infer<typeof openPrSchema>): Promise<string> {
    // CONTAINERIZED: the host has no workspace row — the daemon owns the repo + token + push + PR. Open
    // (or find) the DRAFT PR over the daemon RPC; it resolves repo/token itself. (No host
    // `WorkspaceService.get` / `projectRecordFor` / `GithubApiService` on this path.)
    if (this.workspaceGit.isContainerized({ workspaceId })) {
      const daemon = this.workspaceGit.daemonFor({ workspaceId });
      if (!daemon)
        return `No live sandbox for ${workspaceId} — can't open the PR.`;
      try {
        const pr = await daemon.openPr({ title, body, draft: true });
        return pr.existing
          ? `A PR for this workspace's shared branch already exists: ${pr.url}`
          : `Opened DRAFT PR: ${pr.url} — mark_pr_ready when it's ready for Dennis.`;
      } catch (err) {
        return `Couldn't open the PR: ${err instanceof Error ? err.message : String(err)}`;
      }
    }

    const ws = this.workspaces.get(workspaceId);
    if (!ws) return `No workspace "${workspaceId}".`;
    if (!ws.sharedBranch) {
      return `${workspaceId} is not on a shared branch — create it with the \`shared\` option; the PR is opened from the shared branch.`;
    }
    // The git port for this workspace's tenancy (local host today; the sandbox once Phase 9 flips on).
    const git = this.workspaceGit.resolve({
      team: ws.team,
      project: ws.project,
      workspaceId,
    });
    // Resolves through the workspace's repo origin too, so a project association lost across a
    // restart (or a tree created pre-registration) recovers instead of failing as "(none)".
    const rec = await git.projectRecordFor(workspaceId);
    if (!rec) {
      return `No registered GitHub repo matches ${workspaceId} (project "${ws.project || '(none)'}") — Dennis can register it via the admin API; until then the shared branch stays local.`;
    }
    const auth = await this.tokens
      .resolve(rec.teamId, rec.tokenName)
      .catch(() => undefined);
    if (!auth) {
      return rec.tokenName
        ? `The project's GitHub token "${rec.tokenName}" isn't in the token store — Dennis can add it via the admin API.`
        : 'No default GitHub token is stored — Dennis can add one via the admin API.';
    }
    try {
      // Ensure origin actually has the branch (idempotent; also runs the repo identity guard).
      const { sharedBranch } = await git.pushSharedToOrigin(workspaceId);
      const { owner, repo } = parseGithubRepo(rec.gitUrl);
      const pr = await this.github.openPullRequest(auth.token, {
        owner,
        repo,
        head: sharedBranch,
        base: rec.defaultBranch,
        title,
        body,
        draft: true,
      });
      return pr.existing
        ? `A PR for ${sharedBranch} already exists: ${pr.url}`
        : `Opened DRAFT PR for ${sharedBranch}: ${pr.url} — mark_pr_ready when it's ready for Dennis.`;
    } catch (err) {
      return `Couldn't open the PR: ${err instanceof Error ? err.message : String(err)}`;
    }
  }
}
