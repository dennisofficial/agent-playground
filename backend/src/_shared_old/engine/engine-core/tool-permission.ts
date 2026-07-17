import type { CanUseTool, PermissionResult } from '@anthropic-ai/claude-agent-sdk';
import { evaluateWriteGuard } from '@workspace/agent-engine';
import { join, relative as relativePath, resolve as resolvePath } from 'node:path';
import type { RunEngineArgs } from '../engine.types';

function isInsideRoot(path: string, root: string): boolean {
  const r = resolvePath(root);
  const p = resolvePath(root, path);
  return p === r || p.startsWith(r.endsWith('/') ? r : `${r}/`);
}

const SKILL_MUTATING_TOOLS = new Set(['Write', 'Edit', 'NotebookEdit']);

export interface SkillGuardCtx {
  composedSkillsDir: string;
  skillsStoreRoot?: string;
  skills: RunEngineArgs['skills'];
  granted: Set<string>;
}

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
