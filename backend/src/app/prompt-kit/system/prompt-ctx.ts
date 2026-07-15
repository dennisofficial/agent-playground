/**
 * prompt-kit / prompt-ctx — the CONTEXT a prompt is assembled against.
 *
 * Everything a fragment might GATE on lives here, never as a field on the fragment itself: the job's kind,
 * the build thread's type, and user/org-specific settings. A fragment's `condition(ctx)` reads this to decide
 * whether it belongs in THIS assembly (e.g. onboarding-only fragments gate `c => c.jobKind === 'onboarding'`).
 */
import type { AutoApproveMode } from '@workspace/shared';
import type { JobKind } from '../../domain';

export interface PromptCtx {
  /** The job's kind (feature | bugfix | onboarding | event). Drives the onboarding vs normal-brain split. */
  jobKind?: JobKind | null;
  /** A build thread's scope label (backend | frontend | …), when assembling a per-thread prompt. */
  threadType?: string | null;
  /** The repo's saved preview recipe (repos.preview_instructions), threaded to build-lane prompts as
   *  READ-ONLY standing context. Present only on WORKER/validate execute turns when a recipe exists;
   *  absent everywhere else ⇒ the preview fragment is omitted and the prompt is byte-identical. */
  previewInstructions?: string | null;
  /** Which WORKER turn this prompt is for. Selects whether batch-only host-tool instructions render.
   *  Absent ⇒ treated as 'batch' (backward-compatible with bare renderAgentPrompt calls). */
  turnPhase?: 'batch' | 'commit';
  /**
   * Per-job ORIENTATION facts, rendered as the `CURRENT JOB` block by `identity.group`. Supplied only on
   * the brain turn (`agent-session-manager`); absent everywhere else (subagents, smoke tests) → the block
   * is omitted entirely, so the prompt stays byte-identical when this is unset. Each field is independently
   * optional (a line drops when its value is absent — e.g. `branch` before a feature branch is cut).
   */
  job?: {
    /** "owner/repo", parsed from the git url (via the resolved repo). */
    repoName?: string;
    /** The feature branch this job stacks on (or the observed live HEAD); omitted until a branch is cut. */
    branch?: string;
    /** The base branch the build cuts from (`job.baseBranch` ?? the repo default). */
    baseBranch?: string;
    /** True when this repo is the Atlas repo itself (slug === ATLAS_REPO_SLUG). Gates the atlas-prod host-tool
     *  fragment so its tools are only DESCRIBED where they're actually registered. Absent everywhere else. */
    isAtlasRepo?: boolean;
  } | null;
  /** User/org-specific settings woven into the prompt. */
  settings?: {
    /** Standing operator/org instructions appended to the assembled prompt when present. */
    userOrgInstructions?: string;
    /**
     * The REPO's opt-in house-style profile, resolved per turn from `repos.convention_profile_slug` by
     * `ConventionProfileResolver`. When present, `conventions.group` wraps `body` in a fixed operator-layer
     * envelope for every build-facing agent. Absent/null on a repo with no attached profile → nothing
     * injected (the prompt is byte-identical to today), so a profile never misfires on a divergent repo.
     */
    repoConventions?: { name: string; body: string } | null;
    /**
     * The rendered CURRENT state of this repo's WORKSPACE PROFILE (mounts, setup script, secret files, MCP
     * servers, skills, house style), produced per turn by `WorkspaceProfileService.render`. Injected by
     * `workspace-profile.group` so the brain SEES what is already provisioned and can keep it current.
     * Absent/empty on a repo with nothing provisioned yet → the group prints "nothing recorded yet".
     */
    workspaceProfile?: string | null;
    /** Per-job AUTO-APPROVE mode — which gates (plan / ship / both) auto-advance with no human. */
    autoApproveMode?: AutoApproveMode;
    /** Per-job AUTO-MERGE toggle — a green, mergeable PR merges itself with no human at the final gate. */
    autoMerge?: boolean;
  };
}
