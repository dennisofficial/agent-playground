import { EEngine, EThreadRole } from "../generated/prisma/enums.js";

/**
 * The two SDKs' reasoning-effort vocabularies do not line up — Claude's `EffortLevel` is
 * `low|medium|high|xhigh|max`, Codex's `CodexEffort` is `none|minimal|low|medium|high|xhigh`. An
 * intersection enum would gut the field: carrying engine-specific tuning IS its job. So each engine
 * gets its own enum, declared here rather than imported, because `domain/` never touches an SDK
 * type — the engine services translate at the boundary where the SDK surface is already quarantined.
 */
export enum EClaudeEffort {
  low = "low",
  medium = "medium",
  high = "high",
  xhigh = "xhigh",
  max = "max",
}

export enum ECodexEffort {
  none = "none",
  minimal = "minimal",
  low = "low",
  medium = "medium",
  high = "high",
  xhigh = "xhigh",
}

/**
 * Everything engine-facing lives inside the union, `model` included. The tempting compromise —
 * flat `model`/`effort` with a union only for the exotica — holds only until an engine disagrees
 * about what a field *is* (Gemini's thinking budget is a token count, not a level), at which point
 * the flat field has to be widened or lied to.
 */
export type EngineConfig =
  | { kind: typeof EEngine.claude; model: string; effort: EClaudeEffort }
  | { kind: typeof EEngine.codex; model: string; effort: ECodexEffort };

/**
 * Engine binding is by ROLE, not user choice — there is no `/engine` command, no override file and
 * no settings surface. This table is hardcoded so it is easy to change as Atlas improves, not so a
 * user can dial it. A thread's config is frozen onto its sessions at creation so history stays
 * truthful when this table changes.
 *
 * Three fields and no more: legacy's `mode`, `execution`, `inputPolicy`, `runner` and prompt
 * binding are all dead — they are `Thread.parentThreadId`, the single turn runner, and the deferred
 * system-prompt module respectively.
 */
export type RoleBinding = {
  role: EThreadRole;
  engine: EngineConfig;
  blurb: string;
};

/**
 * Every Claude role runs opus-5, `builder` included. Legacy ran builders on sonnet/high; that is
 * deliberately not restored, because Sonnet's effective context is roughly half Opus's, so a cheap
 * builder rotates about twice as often — and a handoff is the lossiest event in the system. The
 * model saving is paid back in rotations and lost prompt cache.
 */
const CLAUDE: Omit<Extract<EngineConfig, { kind: typeof EEngine.claude }>, "effort"> = {
  kind: EEngine.claude,
  model: "claude-opus-5",
};

const CODEX: Omit<Extract<EngineConfig, { kind: typeof EEngine.codex }>, "effort"> = {
  kind: EEngine.codex,
  model: "gpt-5.6-sol",
};

export const ROLE_BINDINGS: Record<EThreadRole, RoleBinding> = {
  intake: {
    role: "intake",
    engine: { ...CLAUDE, effort: EClaudeEffort.high },
    blurb: "scope the work",
  },
  research: {
    role: "research",
    engine: { ...CLAUDE, effort: EClaudeEffort.high },
    blurb: "explore a question",
  },
  prototype: {
    role: "prototype",
    engine: { ...CLAUDE, effort: EClaudeEffort.high },
    blurb: "throwaway prototype",
  },
  task: {
    role: "task",
    engine: { ...CLAUDE, effort: EClaudeEffort.high },
    blurb: "do the scoped work",
  },
  designer: {
    role: "designer",
    engine: { ...CLAUDE, effort: EClaudeEffort.high },
    blurb: "design the surface",
  },
  planner: {
    role: "planner",
    engine: { ...CLAUDE, effort: EClaudeEffort.high },
    blurb: "write the spec set",
  },
  // Review roles go to Codex deliberately — a second engine reviewing the first is the point. They
  // are also the only roles that earn the effort axis: `xhigh` is "look harder than the author
  // did", and legacy set exactly this. Everything else takes `high`, which is Claude's own default.
  plan_review: {
    role: "plan_review",
    engine: { ...CODEX, effort: ECodexEffort.xhigh },
    blurb: "review the plan",
  },
  builder: {
    role: "builder",
    engine: { ...CLAUDE, effort: EClaudeEffort.high },
    blurb: "build against the specs",
  },
  master_review: {
    role: "master_review",
    engine: { ...CODEX, effort: ECodexEffort.xhigh },
    blurb: "review the work so far",
  },
  post_build: {
    role: "post_build",
    engine: { ...CLAUDE, effort: EClaudeEffort.high },
    blurb: "tidy up after the build",
  },
  ci: {
    role: "ci",
    engine: { ...CLAUDE, effort: EClaudeEffort.high },
    blurb: "chase a red build",
  },
};

export function bindingFor(role: EThreadRole): RoleBinding {
  return ROLE_BINDINGS[role];
}

export function engineFor(role: EThreadRole): EEngine {
  return ROLE_BINDINGS[role].engine.kind;
}

/**
 * Reads a config back off a session row, whose column is untyped JSON. Returns `null` rather than
 * throwing or guessing: rows written before this column existed carry `null`, and a row written by
 * an older build may name an engine or an effort this build no longer knows. The caller decides
 * what a missing config means — the session's flat `engine`/`model` are still there.
 */
export function parseEngineConfig(value: unknown): EngineConfig | null {
  if (typeof value !== "object" || value === null) return null;
  const candidate = value as Record<string, unknown>;
  const { kind, model, effort } = candidate;
  if (typeof model !== "string" || typeof effort !== "string") return null;

  if (kind === EEngine.claude && isMember(EClaudeEffort, effort)) {
    return { kind: EEngine.claude, model, effort };
  }
  if (kind === EEngine.codex && isMember(ECodexEffort, effort)) {
    return { kind: EEngine.codex, model, effort };
  }
  return null;
}

/** Narrows a raw string to a member of a string enum without asserting it is one. */
function isMember<T extends Record<string, string>>(
  members: T,
  value: string,
): value is T[keyof T] {
  return Object.values(members).includes(value);
}

// There is deliberately NO role → phase table here, and re-adding one would be a regression. A role
// does not imply a phase: `research` and `prototype` are intake work as often as design work, and a
// `planning` phase can host an `intake` thread. The relation runs the other way — a phase declares
// which roles it may host — and a new thread simply joins the phase the job is currently in.

export function roleLabel(role: EThreadRole): string {
  return role.replace(/_/g, " ");
}
