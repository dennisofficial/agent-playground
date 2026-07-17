import type { CanUseTool, PermissionResult } from '@anthropic-ai/claude-agent-sdk';
import { evaluateWriteGuard } from '@workspace/agent-engine';
import { join, relative as relativePath, resolve as resolvePath } from 'node:path';
import type { RunEngineArgs } from '../engine.types';

/** Is `path` inside `root` (after resolution)? Confines writes to the worktree. */
function isInsideRoot(path: string, root: string): boolean {
  const r = resolvePath(root);
  const p = resolvePath(root, path);
  return p === r || p.startsWith(r.endsWith('/') ? r : `${r}/`);
}

/** The tool names whose `input.file_path` can mutate a skill — read-only-by-default gate applies to all three. */
const SKILL_MUTATING_TOOLS = new Set(['Write', 'Edit', 'NotebookEdit']);

/**
 * Skills read-only enforcement context: the per-turn composed dir + store mount + resolved skill list
 * `makeCanUseTool` needs to recognize a skill path and name it in the deny message. Optional — a turn with
 * no skills resolved (or a non-Claude/legacy caller) passes none and the skill check is simply skipped.
 */
export interface SkillGuardCtx {
  /** `<CLAUDE_CONFIG_DIR>/skills` — the write-through symlink dir `composeSkillsDir` maintains. */
  composedSkillsDir: string;
  /** The org-scoped skills-store mount root (`CONTAINER_SKILLS_STORE` in-sandbox), if the run has one. */
  skillsStoreRoot?: string;
  /** This turn's resolved skills (name + store-relative dirPath) — used to name a store-mount path. */
  skills: RunEngineArgs['skills'];
  /** Skill names this SESSION already holds an edit grant for (`RunEngineArgs.grantedSkills`). */
  granted: Set<string>;
}

/** Which skill (if any) `filePath` belongs to — the composed symlink dir first (structural: the first path
 *  segment under it IS the skill name), then a match against a resolved skill's store dir (the model
 *  resolved the symlink and is addressing the real path). Undefined → not a skill path at all. */
function skillNameForPath(filePath: string, ctx: SkillGuardCtx): string | undefined {
  if (isInsideRoot(filePath, ctx.composedSkillsDir)) {
    const rel = relativePath(
      resolvePath(ctx.composedSkillsDir),
      resolvePath(ctx.composedSkillsDir, filePath),
    );
    const name = rel.split(/[/\\]/)[0];
    if (name) return name;
  }
  if (ctx.skillsStoreRoot) {
    for (const skill of ctx.skills ?? []) {
      if (isInsideRoot(filePath, join(ctx.skillsStoreRoot, skill.dirPath))) return skill.name;
    }
  }
  return undefined;
}

/** Re-applies the safety boundary to Claude's built-in tools (programmatic gate — never blocks on a
 * human). A 'plan' turn runs under the SDK's native plan mode (the CLI itself enforces read-only);
 * ExitPlanMode's input carries the plan, which we capture then DENY (approving would flip the live
 * session into execution). The Write/Edit/bash read-only branches are belt-and-braces.
 *
 * `roots` is the set of directories Write/Edit may target (the worktree `cwd` plus any extra writable
 * mounts like the durable `/context` shared folder). A write is allowed if it lands inside ANY root. */
export function makeCanUseTool(
  readOnly: boolean,
  roots: string | string[],
  onPlan: (plan: string) => void,
  skillGuard?: SkillGuardCtx,
  writeGuard?: (toolName: string, input: unknown) => { allow: boolean; reason?: string },
): CanUseTool {
  const allowedRoots = (Array.isArray(roots) ? roots : [roots]).filter(Boolean);
  return async (toolName, input): Promise<PermissionResult> => {
    if (toolName === 'ExitPlanMode') {
      if (typeof input.plan === 'string') onPlan(input.plan);
      return {
        behavior: 'deny',
        message: 'Plan recorded — ending the planning turn.',
      };
    }
    const readOnlyVerdict = evaluateWriteGuard(toolName, input, {
      readOnly,
      roots: [],
    });
    if (!readOnlyVerdict.allow) {
      return {
        behavior: 'deny',
        message: readOnlyVerdict.reason ?? 'This is a read-only turn — no file writes.',
      };
    }
    if (skillGuard && SKILL_MUTATING_TOOLS.has(toolName)) {
      const path = typeof input.file_path === 'string' ? input.file_path : '';
      const skillName = path ? skillNameForPath(path, skillGuard) : undefined;
      if (skillName) {
        if (skillGuard.granted.has(skillName)) return { behavior: 'allow', updatedInput: input };
        return {
          behavior: 'deny',
          message:
            `This skill is read-only. Call request_skill_edit_access({ skill: '${skillName}' }) to request ` +
            'edit access for this session, then retry your edit.',
        };
      }
    }
    const rootVerdict = evaluateWriteGuard(toolName, input, {
      readOnly: false,
      roots: allowedRoots,
    });
    if (!rootVerdict.allow) {
      return {
        behavior: 'deny',
        message: rootVerdict.reason ?? 'Write outside the allowed roots is not allowed.',
      };
    }
    if (writeGuard) {
      const verdict = writeGuard(toolName, input);
      if (!verdict.allow)
        return {
          behavior: 'deny',
          message: verdict.reason ?? 'Denied by write guard.',
        };
    }
    return { behavior: 'allow', updatedInput: input };
  };
}
