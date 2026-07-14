import {
  Column,
  Entity,
  Index,
  JoinColumn,
  ManyToOne,
  PrimaryGeneratedColumn,
  Unique,
} from 'typeorm';
import type { AutoMergeMethod } from '@workspace/shared';
import { TimestampedEntity } from '@workspace/shared/schemas';
import type { SeenTooling } from '../../workspace-profile/seen-tooling';
import { OrganizationEntity } from './organization.entity';

/**
 * A connected GitHub repo — what Atlas works against. Org ⊃ repos; threads/memory scope to a repo via
 * `repo_id` (this row's `id`, a `uuid`). `slug` is the URL-safe, human-readable identity (unique within
 * the org) used for the on-disk clone dir, worktree key, container label, and UX — DB relations use
 * `id`. `access_ok` records whether the org's GitHub token reached the repo at connect time; onboarding
 * activates the org only on validated access.
 */
@Entity({ name: 'repos' })
@Index(['org_id'])
@Unique(['org_id', 'slug'])
export class RepoEntity extends TimestampedEntity {
  /** DB-generated UUID — the FK target child rows store. */
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  /** The owning org (FK → organizations.id). */
  @Column({ type: 'uuid' })
  org_id!: string;

  @ManyToOne(() => OrganizationEntity, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'org_id' })
  org?: OrganizationEntity;

  /** URL-safe slug, unique within the org (derived from the repo name). The clone/worktree/UX identity. */
  @Column({ type: 'text' })
  slug!: string;

  /** Display name. */
  @Column({ type: 'text' })
  name!: string;

  /** HTTPS GitHub URL — cloned locally for the per-thread worktree sandboxes. */
  @Column({ type: 'text' })
  git_url!: string;

  /** The PR base branch. */
  @Column({ type: 'text', default: 'main' })
  default_branch!: string;

  /**
   * Per-repo branch-naming prefix for the canonical feature branch the host computes and Atlas cuts
   * (name = `<prefix><job-id-first-8>`, e.g. `feat/a1b2c3d4`). Null → the built-in `feature/`
   * default. Lets a repo enforce its own convention (e.g. `feat/`) without random branch names.
   */
  @Column({ type: 'text', nullable: true })
  branch_prefix!: string | null;

  /**
   * Optional regex the computed/observed feature branch name must satisfy — a soft convention guard
   * (validation + surfaced warning, not a hard block; Atlas owns git in-sandbox). Null → no validation.
   */
  @Column({ type: 'text', nullable: true })
  branch_regex!: string | null;

  /**
   * Per-repo bring-up script the host runs on every COLD sandbox attach (a fresh container create,
   * a restart-from-stopped, or a `reset_sandbox` recreate) — SKIPPED on a warm-running reuse. Must be
   * IDEMPOTENT: it re-runs on each cold boot, so guard the one-time work (`[ -d node_modules ] || pnpm
   * install`, etc.). It must NOT init git submodules — `LocalGitService.ensureSubmodules` already does that
   * on every cut/restored worktree. Authored by the brain via `write_setup_script` (DB-backed, live for
   * every future job on the repo, no PR). Null → no setup step.
   */
  @Column({ type: 'text', nullable: true })
  setup_script!: string | null;

  /**
   * Per-repo PREVIEW RECIPE — the Atlas-managed instructions for standing up THIS repo's
   * demo-ready preview stack (envs to set, ports, docker-compose/migrate/seed commands, deep-link).
   * Spliced into the "Spin up preview" seed (see `previewPrepRule` / `composePreviewPrepSeed`) so Atlas
   * does not re-discover the stack each time; authored by the brain via `write_preview_instructions`
   * (DB-backed, live for every future job on the repo, no PR). Null → no recipe saved yet.
   */
  @Column({ type: 'text', nullable: true })
  preview_instructions!: string | null;

  /**
   * The dependency-manifest filenames the Workspace Profile has ACKNOWLEDGED for this repo (e.g.
   * `["package.json","go.mod"]`) — seeded at `finish_onboarding` (the bulk pass looked at the whole
   * stack) and refreshed when the brain records a setup script. `WorkspaceProfileService.computeGaps`
   * compares the worktree's current manifests against this to flag a NEW stack the profile hasn't
   * covered (suggest a skill/MCP). NULL = never seeded (no new-stack gap emitted until it is).
   */
  @Column({ type: 'jsonb', nullable: true })
  profile_seen_manifests!: string[] | null;

  /**
   * The per-repo seen-tooling ledger for the install-awareness nudge. Each entry is a tool the host
   * ProfileAwarenessService has already surfaced an awareness nudge for; a later install of the same tool is
   * deduped (suppressed). Distinct from `profile_seen_manifests` (root-manifest new-stack signal) — this is
   * a tracked set and never touched by the manifest writers. null = never recorded.
   */
  @Column({ type: 'jsonb', nullable: true })
  profile_seen_tooling!: SeenTooling[] | null;

  /** Named GitHub-token override; null → the org default token. */
  @Column({ type: 'text', nullable: true })
  token_name!: string | null;

  /**
   * Opt-in pointer to a reusable house-style profile ({@link ConventionProfileEntity}.slug within this org).
   * When set, that profile's `body` is injected into every build-facing prompt for jobs on this repo. Null =
   * no house style injected (the safe default) — a repo only adopts a style when the operator or the
   * onboarding brain (`propose_convention_profile`, owner-gated) explicitly attaches one. Not a real FK
   * (a profile may be renamed/removed out from under it; the resolver treats a dangling slug as null).
   */
  @Column({ type: 'text', nullable: true })
  convention_profile_slug!: string | null;

  /** Default GitHub merge method for auto-merge / the manual Merge PR button on this repo's jobs. */
  @Column({ type: 'text', default: 'squash' })
  default_auto_merge_method!: AutoMergeMethod;

  /** Whether to delete the head branch after a merge, for this repo's jobs. */
  @Column({ type: 'boolean', default: true })
  default_auto_merge_delete_branch!: boolean;

  /** Whether the org's GitHub token reached the repo at the last connect/validate. */
  @Column({ type: 'boolean', default: false })
  access_ok!: boolean;

  /** When access was last validated; null until first checked. */
  @Column({ type: 'timestamptz', nullable: true })
  access_checked_at!: Date | null;

  /**
   * The id of the repo-onboarding thread (`kind='onboarding'`) spawned when this repo was connected on a
   * runnable org — the RE-SPAWN SUPPRESSION marker. Set the moment the onboarding thread is created (NOT
   * waiting for it to finish), so a reconnect/revalidate never spawns a second one. Null = never onboarded
   * (eligible to spawn). Distinct from {@link onboarded_at} on purpose: this marks "started", that marks
   * "the workspace config is live". Cleared if the onboarding thread is deleted before finishing, so a
   * re-connect can re-spawn. Not a real FK (the thread may be deleted out from under it).
   */
  @Column({ type: 'uuid', nullable: true })
  onboarding_job_id!: string | null;

  /**
   * PROOF the repo's worktree provisioning config is live — stamped only when the onboarding thread's
   * `.atlas/worktree.json` PR MERGES (or immediately at `finish_onboarding` when there was nothing to
   * commit, e.g. secrets-only). NOT a spawn gate (that's {@link onboarding_job_id}); a closed/unmerged
   * config PR must never leave a repo falsely marked onboarded. Null until then.
   */
  @Column({ type: 'timestamptz', nullable: true })
  onboarded_at!: Date | null;

  /**
   * Non-fatal webhook-registration warning surfaced to the operator — set when the org's GitHub token
   * lacks `admin:repo_hook` so Atlas could not register the delivery webhook (PR state still syncs via the
   * 30-minute poll). Null when the hooks registered cleanly (or registration was skipped for a local/non-
   * public backend). Written fire-and-forget after connect/revalidate, so it can only surface here (row),
   * not in the synchronous connect response.
   */
  @Column({ type: 'text', nullable: true })
  webhook_warning!: string | null;
}
