import type { McpSurface } from '../persistence/entities';

/**
 * A built-in skill Atlas ships, code-defined like `system-mcp-registry.ts`'s `SystemMcpServer` — the BASE
 * layer composed into every turn's `<CLAUDE_CONFIG_DIR>/skills/`, under an org/repo skill of the same
 * `name` (see `SkillResolver.resolveForTurn`'s precedence merge). Its real `SKILL.md` (+ any support
 * files) lives at `<managedSkillsRootHost()>/<name>/` — see `system-skill-store-paths.ts`.
 */
export interface SystemSkill {
  name: string;
  description: string;
  /** Which turn surfaces this skill is active on — same shape as `WorkspaceSkillEntity.surfaces`. */
  surfaces: McpSurface[];
}

/**
 * The system-tier (Atlas-managed) skills. A PURE function (unit-testable with no DI, like
 * `buildSystemMcpServers`) — resolved per turn by `SkillResolver.resolveForTurn` and, for display, by
 * `SystemSkillResolver`.
 *
 * Ships with NONE by default — the actual built-in content is the operator's to author (see
 * `backend/skills-managed/README.md`), not invented here. To add one:
 *   1. create `backend/skills-managed/<name>/SKILL.md` (+ any `references/`/`scripts/` it needs)
 *   2. add `{ name, description, surfaces }` below — `description` should match the SKILL.md frontmatter
 */
export function buildSystemSkills(): SystemSkill[] {
  return [
    // { name: 'example', description: 'Use when …', surfaces: ['brain', 'build', 'review'] },
  ];
}
