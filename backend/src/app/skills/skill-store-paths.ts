import { join } from 'node:path';
import { repoStateDir } from '../state-root';

/**
 * Path helpers for the central, durable skills store — real directories on the host (`SKILL.md` +
 * supporting files) that back the `workspace_skills` registry rows (see `WorkspaceSkillEntity`). Mirrors
 * `SandboxRefsService`'s `/refs` reference library: ONE org's whole subtree is bind-mounted into every
 * sandbox for that org (`orgSkillsRootHost`), so an in-container symlink under that mount never needs to
 * know or leak another org's slug. Default local root is `.atlas-state/skills` (see `repoStateDir`);
 * `SKILLS_ROOT` overrides it in prod (`/srv/atlas/data/skills`, mirroring `AGENT_HOME_ROOT`/`REFS_ROOT`).
 *
 * Layout: `<store>/orgs/<orgId>/<name>/…` (org-scoped) and `<store>/orgs/<orgId>/repos/<repoId>/<name>/…`
 * (repo-scoped) — the same `'*'`/`<repoId>` scope sentinel as `WorkspaceSkillEntity.scope`.
 */

/** Sanitize one path segment (an org/repo id or a skill name) — never let it escape the store root. */
function safe(part: string): string {
  return part.replace(/[^a-z0-9_-]/gi, '_') || 'x';
}

/** The HOST root of the central skills store — `SKILLS_ROOT` when set, else the repo-relative
 *  `.atlas-state/skills`. */
export function skillsStoreRoot(root: string | undefined): string {
  return root ?? repoStateDir('skills');
}

/**
 * The HOST dir for one org's WHOLE skills subtree — its org-scoped skills plus its `repos/` dir. This is
 * what `SandboxManager` bind-mounts into every sandbox for that org (see `CONTAINER_SKILLS_STORE`),
 * exactly like `SandboxRefsService.teamRefsDir`.
 */
export function orgSkillsRootHost(root: string | undefined, orgId: string): string {
  return join(skillsStoreRoot(root), 'orgs', safe(orgId));
}

/**
 * The HOST dir for one skill, given its DB `(org_id, scope, name)`. `scope==='*'` → org-scoped
 * (`<org-root>/<name>`); otherwise `scope` is a repo id → repo-scoped (`<org-root>/repos/<repoId>/<name>`).
 */
export function skillDirHost(root: string | undefined, orgId: string, scope: string, name: string): string {
  return join(orgSkillsRootHost(root, orgId), skillRelativeDir(scope, name));
}

/**
 * A skill's dir, relative to whichever ORG-SCOPED skills root the consumer resolves locally — the host's
 * `orgSkillsRootHost` or the sandbox's `CONTAINER_SKILLS_STORE` (both already scoped to one org, so this
 * never carries an org segment). This is the shape `SkillResolver.resolveForTurn` puts on `ResolvedSkill`,
 * so it crosses the wire org-agnostic and the in-container compose step (`engine-core.ts`) joins it
 * against its own `CONTAINER_SKILLS_STORE` without knowing anything about scope/DB rows.
 */
export function skillRelativeDir(scope: string, name: string): string {
  return scope === '*' ? safe(name) : join('repos', safe(scope), safe(name));
}

/**
 * The HOST root of the GIT-SOURCED managed-skills tier — `ManagedSkillSyncService`'s sync target for a
 * `system-skill-registry.ts` entry that carries a `git` source (as opposed to a STATIC managed entry,
 * committed under `backend/skills-managed/` — see `system-skill-store-paths.ts`). A reserved subtree of
 * this SAME central store, `_managed`, a SIBLING of `orgs/` — never collides with an org id (org ids only
 * ever land under `orgs/<safe(orgId)>`). Global/org-agnostic: unlike the rest of this file, there is no
 * per-org scoping here — one sync, shared by every org's turns.
 */
export function managedGitSkillsRootHost(root: string | undefined): string {
  return join(skillsStoreRoot(root), '_managed');
}

/** One git-sourced managed skill's dir, given its registry `name`. Same sanitization as {@link safe}. */
export function managedGitSkillDirHost(root: string | undefined, name: string): string {
  return join(managedGitSkillsRootHost(root), safe(name));
}

/** A git-sourced managed skill's dir, relative to whichever git-managed root the consumer resolves
 *  locally — the host's {@link managedGitSkillsRootHost} or the sandbox's `CONTAINER_SKILLS_MANAGED_GIT`.
 *  Mirrors `system-skill-store-paths.ts`'s `managedSkillRelativeDir` for the static managed tier. */
export function managedGitSkillRelativeDir(name: string): string {
  return safe(name);
}
