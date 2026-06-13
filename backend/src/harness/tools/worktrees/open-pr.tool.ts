import { z } from 'zod';
import { parseGithubRepo } from '../../projects/git-auth';
import { GithubApiService } from '../../projects/github-api.service';
import { GithubTokenStore } from '../../projects/github-token-store';
import { WorktreeService } from '../../worktrees/worktree.service';
import { HarnessTool } from '../harness-tool.decorator';
import type { IHarnessTool } from '../tool.types';

const openPrSchema = z.object({
  worktreeId: z
    .string()
    .describe('The worktree whose shared branch the PR is for.'),
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
    "Open (or find) the pull request for a feature's shared branch on the project's registered GitHub repo — as a DRAFT, so it doesn't read as ready while you're still working. Returns the PR URL to relay. Call it ONCE per feature: publish_worktree keeps the shared branch synced, so later publishes update the open PR by themselves. When the work is done and you want Dennis to review, mark_pr_ready flips it out of draft.";
  readonly schema = openPrSchema;

  constructor(
    private readonly worktrees: WorktreeService,
    private readonly tokens: GithubTokenStore,
    private readonly github: GithubApiService,
  ) {}

  async execute({
    worktreeId,
    title,
    body,
  }: z.infer<typeof openPrSchema>): Promise<string> {
    const wt = this.worktrees.get(worktreeId);
    if (!wt) return `No worktree "${worktreeId}".`;
    if (!wt.sharedBranch) {
      return `${worktreeId} is not on a shared branch — create it with the \`shared\` option; the PR is opened from the shared branch.`;
    }
    // Resolves through the worktree's repo origin too, so a project association lost across a
    // restart (or a tree created pre-registration) recovers instead of failing as "(none)".
    const rec = await this.worktrees.projectRecordFor(worktreeId);
    if (!rec) {
      return `No registered GitHub repo matches ${worktreeId} (project "${wt.project || '(none)'}") — Dennis can register it via the admin API; until then the shared branch stays local.`;
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
      const { sharedBranch } =
        await this.worktrees.pushSharedToOrigin(worktreeId);
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
