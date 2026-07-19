/**
 * Admin API response shapes — the cross-app contract between the backend admin
 * endpoints and the admin web UI. Pure TypeScript: no TypeORM, no class-validator.
 * Safe to import in any package including frontend bundles.
 */
import type { BranchingPolicy } from './branching';

/**
 * The four memory-sharing tiers that a fact's scope belongs to.
 * Mirrors the scope prefix hierarchy in the backend's `domain/identity.ts`.
 */
export type Tier = 'team' | 'project' | 'bot' | 'private';

/** Full fact response shape for the Memory Viewer API. */
export interface FactView {
  id: number;
  /** The fact text — `content` per the Memory Viewer API contract (spec field name). */
  content: string;
  tier: Tier;
  /** Bot id parsed from scope; null for team/project-tier facts. */
  botId: string | null;
  /** Project id parsed from scope; null for non-project facts. */
  projectId: string | null;
  /** Human participant parsed from a pair scope; null for non-private facts. */
  humanId: string | null;
  confidence: number;
  createdAt: string;
  /** Included for client-side sort and last-updated display. */
  updatedAt: string;
  /** ISO timestamp when soft-deleted; null if the fact is active. */
  deletedAt: string | null;
}

/**
 * Paginated fact list response — `{ items, total, limit, offset }`.
 * `total` allows the client to compute pagination controls and the
 * per-tier live/forgotten count hint without a second request.
 */
export interface FactListResponse {
  items: FactView[];
  total: number;
  limit: number;
  offset: number;
}

/** Query params for `listFacts` / `listAllFacts`. All optional. */
export interface FactQuery {
  tier?: Tier;
  projectId?: string;
  botId?: string;
  assertedBy?: string;
  q?: string;
  includeDeleted?: boolean;
  includeGlobal?: boolean;
  limit?: number;
  offset?: number;
  sort?: 'updated' | 'created';
}

/**
 * Lightweight workspace summary for the admin UI workspace picker.
 *
 * `slug` is the same value as `id` (the Slack `team_id`): there is no separate
 * slug column in the `tenants` table, and the Slack team ID already serves as
 * the canonical URL-safe unique identifier. If a human-readable slug is needed
 * in a future iteration, a column migration is the right fix.
 */
export interface TenantView {
  /** Slack team id — the `:teamId` path param in all tenant-scoped endpoints. */
  id: string;
  /** Human-readable workspace display name. */
  name: string;
  /** URL-safe workspace identifier (same as `id` — see jsdoc above). */
  slug: string;
}

/** A registered project: binds a project id (the slug rooms carry) to a GitHub repo. */
export interface ProjectRecord {
  /** The tenant (Slack team id) this project belongs to. */
  teamId: string;
  projectId: string;
  displayName: string;
  /** One-line catalog blurb shown to Atlas (what the project is); null when unset. */
  description: string | null;
  /** HTTPS GitHub URL (validated at the API edge). */
  gitUrl: string;
  /** The PR base branch. */
  defaultBranch: string;
  /** Per-project git branching policy (how workstation branches are derived); null → the default. */
  branchingPolicy: BranchingPolicy | null;
  /** Named token override; null -> the default token. */
  tokenName: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface NewProject {
  teamId: string;
  projectId: string;
  displayName: string;
  description?: string | null;
  gitUrl: string;
  defaultBranch?: string;
  branchingPolicy?: BranchingPolicy | null;
  tokenName?: string | null;
}

/** Token METADATA — the only shape that ever leaves the store besides `resolve()`. */
export interface GithubTokenMeta {
  name: string;
  isDefault: boolean;
  createdAt: string;
  updatedAt: string;
}

// Plan Viewer — read-only shapes powering the web Plan Viewer (`/plans/:teamId/:taskId`)
// and the board/pipeline dashboards. A plan is rendered as diagrams + prose instead of a
// wall of markdown; these DTOs carry the data the viewer renders.

/** A team-board task as shown in the plan viewer / board dashboard. */
export interface BoardTaskView {
  id: number;
  project: string;
  title: string;
  description: string;
  /** open | planning | awaiting_approval | approved | executing | self_review | in_review | done */
  status: string;
  assignee: string | null;
  createdBy: string;
  /** Same-team task ids this one waits on. */
  dependsOn: number[];
  sharedSlug: string | null;
  createdAt: string;
  updatedAt: string;
}

/**
 * The single current plan row attached to a task (`team_task_plans` is latest-wins, one row per
 * task). `planMd` may contain ```mermaid fences the planner authored.
 */
export interface PlanRowView {
  id: number;
  taskId: number;
  /** Roster id of the authoring role — provenance only. */
  employee: string;
  planMd: string;
  /** 'pending' | 'approved' — the lead's review verdict on this version. */
  leadStatus: string;
  /** 'executing' | 'reviewed' | 'complete' | 'blocked' — execution state. */
  ownerStatus: string;
  prUrl: string | null;
  createdAt: string;
  updatedAt: string;
}

/** One build phase within a feature-pipeline section. */
export interface PhaseView {
  id: string;
  sectionId: string;
  ordinal: number;
  /** The stable phase id from the plan's fenced `phases` block. */
  planPhaseId: number;
  title: string | null;
  /** 'pending' | 'building' | 'reviewing' | 'done' | 'failed' | 'skipped' */
  status: string;
}

/** One section of a feature pipeline, with its archived approved plan + phases. */
export interface SectionView {
  id: string;
  /** Execution order, gap-numbered (10, 20, 30…). */
  ordinal: number;
  name: string;
  brief: string | null;
  phaseRole: string;
  /** 'pending' | 'planning' | 'building' | 'done' | 'failed' */
  status: string;
  /** The section's archived approved plan markdown (may contain ```mermaid fences). */
  planMd: string | null;
  /** This run's section ordinals this section depends on (for the dependency graph). */
  dependsOn: number[];
  phases: PhaseView[];
}

/** A feature-pipeline run for a task, with ordered sections + phases. */
export interface PipelineRunView {
  id: string;
  taskId: number;
  pipeline: string;
  /** 'feature' | 'bugfix'. */
  kind: string;
  /** 'running' | 'paused' | 'done' | 'failed' */
  status: string;
  planningSubstep: string | null;
  overview: string | null;
  activeSectionId: string | null;
  sectionIndex: number;
  phaseIndex: number;
  createdAt: string;
  updatedAt: string;
  sections: SectionView[];
}

/**
 * Full plan-viewer payload for one task: the task, its single current plan, and (for feature work)
 * the pipeline run whose sections each carry their own archived plan. The viewer MERGES the current
 * plan with the per-section archives — `team_task_plans` is not a history.
 */
export interface PlanView {
  task: BoardTaskView;
  currentPlan: PlanRowView | null;
  pipeline: PipelineRunView | null;
}
