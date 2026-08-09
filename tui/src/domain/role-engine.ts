import { EEngine, EGroupKind, EThreadRole } from "../generated/prisma/enums.js";

/**
 * Engine binding is by ROLE, not user choice — there is no `/engine` command. A thread's engine is
 * frozen onto its sessions at creation so history stays truthful when this table changes.
 */
export type RoleBinding = {
  role: EThreadRole;
  engine: EEngine;
  model: string;
  blurb: string;
};

const CLAUDE_MODEL = "claude-opus-5";
const CODEX_MODEL = "gpt-5.6-sol";

export const ROLE_BINDINGS: Record<EThreadRole, RoleBinding> = {
  intake: {
    role: "intake",
    engine: EEngine.claude,
    model: CLAUDE_MODEL,
    blurb: "scope the work",
  },
  research: {
    role: "research",
    engine: EEngine.claude,
    model: CLAUDE_MODEL,
    blurb: "explore a question",
  },
  spike: {
    role: "spike",
    engine: EEngine.claude,
    model: CLAUDE_MODEL,
    blurb: "throwaway prototype",
  },
  designer: {
    role: "designer",
    engine: EEngine.claude,
    model: CLAUDE_MODEL,
    blurb: "design the surface",
  },
  planner: {
    role: "planner",
    engine: EEngine.claude,
    model: CLAUDE_MODEL,
    blurb: "write the spec set",
  },
  // Review roles go to Codex deliberately — a second engine reviewing the first is the point.
  plan_review: {
    role: "plan_review",
    engine: EEngine.codex,
    model: CODEX_MODEL,
    blurb: "review the plan",
  },
  builder: {
    role: "builder",
    engine: EEngine.claude,
    model: CLAUDE_MODEL,
    blurb: "build against the specs",
  },
  master_review: {
    role: "master_review",
    engine: EEngine.codex,
    model: CODEX_MODEL,
    blurb: "review the work so far",
  },
  post_build: {
    role: "post_build",
    engine: EEngine.claude,
    model: CLAUDE_MODEL,
    blurb: "tidy up after the build",
  },
  ci: {
    role: "ci",
    engine: EEngine.claude,
    model: CLAUDE_MODEL,
    blurb: "chase a red build",
  },
};

export function bindingFor(role: EThreadRole): RoleBinding {
  return ROLE_BINDINGS[role];
}

export function engineFor(role: EThreadRole): EEngine {
  return ROLE_BINDINGS[role].engine;
}

export const ROLE_GROUP: Record<EThreadRole, EGroupKind> = {
  intake: EGroupKind.intake,
  research: EGroupKind.design,
  spike: EGroupKind.design,
  designer: EGroupKind.design,
  planner: EGroupKind.planning,
  plan_review: EGroupKind.planning,
  builder: EGroupKind.build,
  master_review: EGroupKind.master_review,
  post_build: EGroupKind.post_build,
  ci: EGroupKind.ci,
};

export function roleLabel(role: EThreadRole): string {
  return role.replace(/_/g, " ");
}
