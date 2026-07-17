/**
 * Web SKILL-PROPOSAL card payload — the owner-approvable skill action the brain poses (during onboarding's
 * bulk pass OR incrementally on any later job) when it notices a reusable skill would help builds on this
 * repo/org. Three modes:
 *   - `create`  — the brain AUTHORED a skill folder as real files (via its built-in `run-skill-generator`)
 *                 under `/context/skill-drafts/<name>`; `propose_skill` froze it into `stagingPath` and
 *                 captured a `preview`. Approval vendors the FROZEN copy into the store (`provenance:'custom'`).
 *   - `install` — the brain proposes INSTALLING a maintained skill from a git marketplace; `installPreview`
 *                 shows the exact resolved name/description + overwrite conflict. Approval routes to
 *                 `SkillInstallerService.install`.
 *   - `remove`  — delete a registered skill (`priorBody` shows what goes).
 * The brain never writes/installs directly — the OWNER approves at
 * `…/jobs/:jobId/skill-proposals/:requestId/approve`. Pure — no I/O, no NestJS. Lifecycle: `proposed → approved`.
 */

export interface WebSkillProposalCard {
  /** Discriminant — the web client checks `type` to decide which component to render. */
  type: 'skill_proposal_card';
  jobId: string;
  /** Stable key for this proposal (the card row's `ts`); the approve POST echoes it back. */
  requestId: string;
  /** The repo whose build raised the proposal (also the write target when `scope==='repo'`). */
  repoId: string;
  /** `'org'` = every repo in the org; `'repo'` = this repo only. Drives the write scope on approval. */
  scope: 'org' | 'repo';
  /** The skill name (the on-disk skill dir; unique within the (org, scope) tier). For `install`, the
   *  RESOLVED frontmatter name (see `installPreview`), not a brain guess. */
  name: string;
  /** The SKILL.md frontmatter `description` — the trigger blurb ("Use when …"). */
  description: string;
  /** Turn surfaces the skill is active on. Defaulted to all lanes (brain|build|review) — the brain no
   *  longer picks; on-demand description-match already gates loading. */
  surfaces: ('brain' | 'build' | 'review')[];
  /** `create` a new authored skill, `install` a maintained one from git, or `remove` a registered one. */
  mode: 'create' | 'install' | 'remove';
  /** The brain's rationale for why the skill helps (shown to the owner). */
  rationale: string;

  // ── create ──────────────────────────────────────────────────────────────────────────────────────────
  /** The FROZEN, request-scoped host staging dir approval vendors from (`.pending/<orgId>/<requestId>`) —
   *  immutable after propose time, so the owner reviews exactly what installs. `create` only. */
  stagingPath?: string;
  /** Read-only preview of the authored skill (SKILL.md text + file tree), captured from the frozen copy. */
  preview?: { skillMd: string; files: string[] };

  // ── install ─────────────────────────────────────────────────────────────────────────────────────────
  sourceUrl?: string;
  sourceRef?: string;
  sourceSubpath?: string;
  /** The exact rows a `SkillInstallerService.preview` dry-run resolved — real name/description + whether
   *  each overwrites an existing skill of the same name. `install` only. */
  installPreview?: {
    rows: { name: string; description: string; overwrites: boolean }[];
  };

  // ── remove ──────────────────────────────────────────────────────────────────────────────────────────
  /** On `remove`, the skill's CURRENT body — so the owner sees what will be deleted. */
  priorBody?: string;

  /** ISO-8601 time the OWNER approved. Terminal "approved" state. */
  approved_at?: string;
  /** ISO-8601 time the owner dismissed the proposal without approving (also releases any staging dir). */
  dismissed_at?: string;
}

/** Build a `WebSkillProposalCard` from the brain's validated skill-tool args. */
export function webSkillProposalCard(input: {
  jobId: string;
  requestId: string;
  repoId: string;
  scope: 'org' | 'repo';
  name: string;
  description: string;
  surfaces: ('brain' | 'build' | 'review')[];
  mode: 'create' | 'install' | 'remove';
  rationale: string;
  stagingPath?: string;
  preview?: { skillMd: string; files: string[] };
  sourceUrl?: string;
  sourceRef?: string;
  sourceSubpath?: string;
  installPreview?: {
    rows: { name: string; description: string; overwrites: boolean }[];
  };
  priorBody?: string;
}): WebSkillProposalCard {
  return {
    type: 'skill_proposal_card',
    jobId: input.jobId,
    requestId: input.requestId,
    repoId: input.repoId,
    scope: input.scope,
    name: input.name,
    description: input.description,
    surfaces: input.surfaces,
    mode: input.mode,
    rationale: input.rationale,
    ...(input.stagingPath !== undefined ? { stagingPath: input.stagingPath } : {}),
    ...(input.preview !== undefined ? { preview: input.preview } : {}),
    ...(input.sourceUrl !== undefined ? { sourceUrl: input.sourceUrl } : {}),
    ...(input.sourceRef !== undefined ? { sourceRef: input.sourceRef } : {}),
    ...(input.sourceSubpath !== undefined ? { sourceSubpath: input.sourceSubpath } : {}),
    ...(input.installPreview !== undefined ? { installPreview: input.installPreview } : {}),
    ...(input.priorBody !== undefined ? { priorBody: input.priorBody } : {}),
  };
}
