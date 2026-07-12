/**
 * prompt-kit / prompt-ctx — the CONTEXT a prompt is assembled against.
 *
 * Everything a fragment might GATE on lives here, never as a field on the fragment itself: the job's kind,
 * the build thread's type, and user/org-specific settings. A fragment's `condition(ctx)` reads this to decide
 * whether it belongs in THIS assembly (e.g. onboarding-only fragments gate `c => c.jobKind === 'onboarding'`).
 */
import type { JobKind } from '../domain';

export interface PromptCtx {
  /** The job's kind (feature | bugfix | onboarding | event). Drives the onboarding vs normal-brain split. */
  jobKind?: JobKind | null;
  /** A build thread's scope label (backend | frontend | …), when assembling a per-thread prompt. */
  threadType?: string | null;
  /** Which WORKER turn this prompt is for. Selects whether batch-only host-tool instructions render.
   *  Absent ⇒ treated as 'batch' (backward-compatible with bare renderAgentPrompt calls). */
  turnPhase?: 'batch' | 'commit' | 'gate';
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
    /** Per-job AUTO-APPROVE is ON — the brain runs autonomously (plan & ship gates auto-advance, no human). */
    autoApprove?: boolean;
  };
}
