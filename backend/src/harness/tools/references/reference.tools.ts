import { z } from 'zod';
import { ProjectStore } from '../../projects/project-store';
import type { ProjectRecord } from '../../projects/project.types';
import { WorktreeService } from '../../worktrees/worktree.service';
import { HarnessTool } from '../harness-tool.decorator';
import type { HarnessToolContext, IHarnessTool } from '../tool.types';

const GITHUB_URL = /^https:\/\/github\.com\/[^/\s]+\/[^/\s]+?(\.git)?$/;

/** Match a catalog entry by project id OR (case-insensitive) display name. */
function findInCatalog(
  catalog: ProjectRecord[],
  name: string,
): ProjectRecord | undefined {
  const n = name.trim().toLowerCase();
  return catalog.find(
    (p) => p.projectId.toLowerCase() === n || p.displayName.toLowerCase() === n,
  );
}

const referenceProjectSchema = z.object({
  name: z
    .string()
    .describe(
      'The project to reference, by its catalog id or display name (e.g. "cubix-infra"). See list_reference_projects for what\'s available.',
    ),
});

/**
 * READ another of Dennis's GitHub-registered projects, read-only, to ground a decision — the "go look
 * at how project X does it" affordance. Resolves the name against the workspace catalog, materializes
 * a read-only clone, and hands back a quick orientation (top level + README). For a deeper read, pass
 * the same name to `investigate({ references: [...] })`. If the project isn't registered yet, the
 * result carries a Remedy pointing at `onboard_project` — take it, don't dead-end.
 */
@HarnessTool()
export class ReferenceProjectTool
  implements IHarnessTool<typeof referenceProjectSchema>
{
  readonly name = 'reference_project';
  readonly description =
    "Read ANOTHER of Dennis's registered projects (read-only) to ground a decision — 'go look at how project X does it'. Give the catalog id or display name (list_reference_projects shows what's available; the catalog is also in your context). It materializes a read-only clone and returns a quick orientation (top level + README head). For a deeper code read, pass the name to investigate({ references: [...] }). If the project isn't registered, the result includes a `Remedy:` line pointing at onboard_project — follow it.";
  readonly schema = referenceProjectSchema;

  constructor(
    private readonly projects: ProjectStore,
    private readonly worktrees: WorktreeService,
  ) {}

  async execute(
    { name }: z.infer<typeof referenceProjectSchema>,
    ctx: HarnessToolContext,
  ): Promise<string> {
    const id = ctx.identity;
    const catalog = await this.projects.list(id.team).catch(() => []);
    const rec = findInCatalog(catalog, name);
    if (!rec) {
      if (GITHUB_URL.test(name.trim()))
        return `"${name}" looks like a GitHub URL — use reference_repo({ url: "${name.trim()}" }) for a one-off, or onboard_project to add it to the catalog.`;
      return `✗ "${name}" isn't a registered project in this workspace.\nRemedy: call onboard_project({ name: "${name}" }) to register it read-only, then retry reference_project. (If you don't think it exists on GitHub, just tell Dennis.)`;
    }
    try {
      const { path } = await this.worktrees.ensureReferenceClone(id.team, {
        projectId: rec.projectId,
      });
      const orientation = await this.worktrees.referenceOrientation(path);
      return `Referenced ${rec.projectId}${rec.description ? ` — ${rec.description}` : ''} (read-only) at ${path}\n\n${orientation}\n\nTo read deeper, investigate({ question, references: ["${rec.projectId}"] }).`;
    } catch (err) {
      return `Couldn't materialize a read-only clone of ${rec.projectId}: ${err instanceof Error ? err.message : String(err)}`;
    }
  }
}

const referenceRepoSchema = z.object({
  url: z
    .string()
    .describe('An https://github.com/<owner>/<repo> URL to read read-only.'),
});

/**
 * The URL fallback for reference_project — read a GitHub repo that ISN'T in the catalog by its URL,
 * one-off, read-only (authed with the workspace's default token). For repos you reference often,
 * onboard_project them instead so they show up in the catalog by name.
 */
@HarnessTool()
export class ReferenceRepoTool
  implements IHarnessTool<typeof referenceRepoSchema>
{
  readonly name = 'reference_repo';
  readonly description =
    "Read a GitHub repo that ISN'T in the catalog, by its URL, read-only (a one-off; authed with the workspace's default token). Returns a quick orientation. For a repo you'll reference repeatedly, onboard_project it instead so it's available by name.";
  readonly schema = referenceRepoSchema;

  constructor(private readonly worktrees: WorktreeService) {}

  async execute(
    { url }: z.infer<typeof referenceRepoSchema>,
    ctx: HarnessToolContext,
  ): Promise<string> {
    const u = url.trim();
    if (!GITHUB_URL.test(u))
      return `✗ "${url}" isn't an https://github.com/<owner>/<repo> URL — reference_repo only reads GitHub repos.`;
    try {
      const { path } = await this.worktrees.ensureReferenceClone(
        ctx.identity.team,
        { gitUrl: u },
      );
      const orientation = await this.worktrees.referenceOrientation(path);
      return `Referenced ${u} (read-only) at ${path}\n\n${orientation}\n\nTo read deeper, investigate the path. If it can't be cloned, the token may lack access — onboard_project can collect one.`;
    } catch (err) {
      return `Couldn't clone ${u} read-only (the default token may not have access): ${err instanceof Error ? err.message : String(err)}\nRemedy: onboard_project({ url: "${u}" }) to collect a token with access.`;
    }
  }
}

const listReferenceSchema = z.object({});

/** List the reference catalog — the registered projects this workspace can read read-only. */
@HarnessTool()
export class ListReferenceProjectsTool
  implements IHarnessTool<typeof listReferenceSchema>
{
  readonly name = 'list_reference_projects';
  readonly description =
    "List the projects you can reference read-only in this workspace (the same catalog that's summarized in your context). Use it when you want the full list/blurbs before deciding what to reference.";
  readonly schema = listReferenceSchema;

  constructor(private readonly projects: ProjectStore) {}

  async execute(
    _args: z.infer<typeof listReferenceSchema>,
    ctx: HarnessToolContext,
  ): Promise<string> {
    const id = ctx.identity;
    const catalog = (await this.projects.list(id.team).catch(() => [])).filter(
      (p) => p.projectId !== id.project,
    );
    if (catalog.length === 0)
      return `No other projects are registered in this workspace yet. Onboard one with onboard_project when Dennis points you at a repo.`;
    return [
      'Reference projects you can read (read-only):',
      ...catalog.map(
        (p) =>
          `• ${p.projectId}${p.displayName && p.displayName !== p.projectId ? ` (${p.displayName})` : ''}${p.description ? ` — ${p.description}` : ''}`,
      ),
    ].join('\n');
  }
}
