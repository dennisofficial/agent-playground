/**
 * Skills & MCP — typed scaffold (this pass wires NO runtime behavior).
 *
 * A skill is an Anthropic Agent Skill package (a directory with a SKILL.md + optional scripts/
 * resources). Employees declare WHERE their skills come from; the loader's job (later pass) is to
 * make every declared source available on the local filesystem at startup and hand the resolved
 * directories to the engines (the Claude Agent SDK consumes skill dirs natively; other engines get
 * a prompt-level rendering).
 */
export type SkillSource =
  /** A git repository holding one skill (or a subPath into a multi-skill repo). Cloned/synced into
   * the local skill cache on startup. */
  | { kind: 'git'; url: string; ref?: string; subPath?: string }
  /** An absolute or repo-relative path to a skill directory already on disk. */
  | { kind: 'local'; path: string };

/** A skill resolved to the local filesystem, ready to hand to an engine. */
export interface LoadedSkill {
  /** Skill name from SKILL.md frontmatter. */
  name: string;
  /** One-line description from SKILL.md frontmatter (used for catalog/progressive disclosure). */
  description: string;
  /** Absolute path to the skill directory (contains SKILL.md). */
  dir: string;
  source: SkillSource;
}

/**
 * An MCP server an employee may use. Mirrors the common stdio/http config shape the Claude Agent
 * SDK and Codex SDK both accept; wiring into the engines is a later pass.
 */
export type McpServerConfig =
  | { name: string; transport: 'stdio'; command: string; args?: string[]; env?: Record<string, string> }
  | { name: string; transport: 'http'; url: string; headers?: Record<string, string> };
