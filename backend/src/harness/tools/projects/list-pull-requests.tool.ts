import { z } from 'zod';
import { recallProjects } from '../../domain/identity';
import { parseGithubRepo } from '../../projects/git-auth';
import { GithubApiService } from '../../projects/github-api.service';
import { GithubTokenStore } from '../../projects/github-token-store';
import { ProjectStore } from '../../projects/project-store';
import { HarnessTool } from '../harness-tool.decorator';
import type { HarnessToolContext, IHarnessTool } from '../tool.types';

const listPrSchema = z.object({
  project: z
    .string()
    .optional()
    .describe(
      "Which project's repo to query; omit for the current room's project.",
    ),
});

/**
 * Read-only query: returns the open pull requests on the project's registered GitHub repo.
 * Useful for the team lead to check what's awaiting review or merge before closing out a feature.
 */
@HarnessTool()
export class ListPullRequestsTool implements IHarnessTool<typeof listPrSchema> {
  readonly name = 'list_pull_requests';
  readonly description =
    "List the open pull requests on the project's registered GitHub repo — returns PR numbers, titles, authors, branches, and URLs. Use it to check what's awaiting review or merge.";
  readonly schema = listPrSchema;

  constructor(
    private readonly projects: ProjectStore,
    private readonly tokens: GithubTokenStore,
    private readonly github: GithubApiService,
  ) {}

  async execute(
    { project }: z.infer<typeof listPrSchema>,
    ctx: HarnessToolContext,
  ): Promise<string> {
    const id = ctx.identity;
    const named = project?.trim().toLowerCase();
    const target =
      named && recallProjects(id).includes(named) ? named : id.project;

    const rec = await this.projects.get(id.team, target);
    if (!rec) {
      return `No registered GitHub repo for project "${target}" — Dennis can register it via the admin API.`;
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
      const { owner, repo } = parseGithubRepo(rec.gitUrl);
      const prs = await this.github.listOpenPullRequests(auth.token, {
        owner,
        repo,
      });
      if (prs.length === 0) {
        return `No open pull requests on ${owner}/${repo}.`;
      }
      const lines = prs.map(
        (pr) =>
          `- #${pr.number} ${pr.title}${pr.draft ? ' [draft]' : ''} — ${pr.author}, ${pr.headBranch} → ${pr.baseBranch}: ${pr.url}`,
      );
      return `Open pull requests on ${owner}/${repo}:\n${lines.join('\n')}`;
    } catch (err) {
      return `Couldn't list the pull requests: ${err instanceof Error ? err.message : String(err)}`;
    }
  }
}
