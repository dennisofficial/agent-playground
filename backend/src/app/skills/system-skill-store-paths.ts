import { join } from 'node:path';
import { monorepoRoot } from '../state-root';

/**
 * Path helpers for Atlas's own MANAGED (system-tier) skills — see `system-skill-registry.ts`. Unlike
 * `skill-store-paths.ts` (the org-scoped, per-tenant store), this is a SINGLE fixed dir, committed to the
 * repo, identical for every org — the skills counterpart of `system-mcp-registry.ts`'s built-ins.
 */

/**
 * Host root of the managed-skills tree — `backend/skills-managed/`, a sibling of `backend/sandbox/` (the
 * SAME "identical in dev `ts-node` and a built `dist` deploy, no `nest-cli` asset copy" trick as
 * `sandboxContextDir` — see `bundle-engine.ts`). `SandboxManager` bind-mounts this whole dir read-only at
 * `CONTAINER_SKILLS_MANAGED`.
 */
export function managedSkillsRootHost(): string {
  return join(monorepoRoot(), 'backend', 'skills-managed');
}

/**
 * One managed skill's dir, relative to {@link managedSkillsRootHost} / `CONTAINER_SKILLS_MANAGED` — flat
 * by name (no org/repo scope tiers; a managed skill is code-defined, not a DB row). Same sanitization as
 * `skill-store-paths.ts`'s `safe()` — never let a name escape the store root.
 */
export function managedSkillRelativeDir(name: string): string {
  return name.replace(/[^a-z0-9_-]/gi, '_') || 'x';
}
