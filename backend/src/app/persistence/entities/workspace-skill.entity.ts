import { Column, Entity, Index, JoinColumn, ManyToOne, PrimaryColumn } from 'typeorm';
import { TimestampedEntity } from '@workspace/shared/schemas';
import { OrganizationEntity } from './organization.entity';
import type { McpSurface } from './mcp-server.entity';

/**
 * The registry row for a user/brain-defined SKILL — a named, real **directory** (`SKILL.md` + supporting
 * `references/`, `scripts/`, assets…) living on the host in the central skills store, resolved host-side
 * per turn by `SkillResolver` and composed into the engine's `<CLAUDE_CONFIG_DIR>/skills/<name>` as a
 * write-through symlink (see `engine-home.ts`). This row is METADATA ONLY — the files on disk are truth;
 * there is no `body` column (skills stopped being single-file markdown blobs — see ARCHITECTURE.md /
 * the skills redesign plan).
 *
 * Composite PK (org_id, scope, name) mirrors {@link McpServerEntity} exactly:
 *   - `scope='*'` → an ORG-level skill, active for every repo/job in the org.
 *   - `scope=<repoId>` → a REPO-level skill, active only for that repo (and OVERRIDES an org skill of the
 *     same `name` on a collision — see `SkillResolver.resolveForTurn`).
 *
 * Unlike {@link McpServerEntity} there are NO secrets here — so there is no `secrets_enc` / encryption.
 * `description` is the skill's trigger blurb (the SKILL.md frontmatter `description`, what the model reads
 * to decide when to load it); kept in sync with the on-disk `SKILL.md` frontmatter by whichever service
 * writes the row (installer/authoring — not yet built, see the skills-redesign plan's P2/P3).
 */
@Entity({ name: 'workspace_skills' })
@Index(['org_id'])
export class WorkspaceSkillEntity extends TimestampedEntity {
  /** The owning org (FK → organizations). */
  @PrimaryColumn({ type: 'uuid' })
  org_id!: string;

  @ManyToOne(() => OrganizationEntity, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'org_id' })
  org?: OrganizationEntity;

  /** '*' = org-wide (all repos); otherwise a repo id — the skill is scoped to that repo only. */
  @PrimaryColumn({ type: 'text', default: '*' })
  scope!: string;

  /** Skill name — the on-disk skill dir + how the model refers to it. Unique within (org, scope). */
  @PrimaryColumn({ type: 'text' })
  name!: string;

  /**
   * The SKILL.md frontmatter `description` — the trigger blurb the model reads to decide WHEN to load the
   * skill. Kept short + specific ("Use when …"). Surfaced in the Workspace Profile snapshot.
   */
  @Column({ type: 'text' })
  description!: string;

  /**
   * Where the skill dir came from. `git` = installed from a repo (source/update columns below apply);
   * `custom` = authored locally in the host store, no remote; `managed` = a future bundled-default tier.
   */
  @Column({ type: 'text', default: 'custom' })
  provenance!: SkillProvenance;

  /** The git remote a `git`-provenance skill was installed from. Null for `custom`/`managed`. */
  @Column({ type: 'text', nullable: true })
  source_url!: string | null;

  /** The branch/tag/ref installed at `source_url`. Null for `custom`/`managed`. */
  @Column({ type: 'text', nullable: true })
  source_ref!: string | null;

  /** Subpath within `source_url` this skill was materialized from (a marketplace repo entry). Null for a
   *  single-skill repo or `custom`/`managed`. */
  @Column({ type: 'text', nullable: true })
  source_subpath!: string | null;

  /** The commit sha last materialized onto disk, for update-detection. Null for `custom`/`managed`. */
  @Column({ type: 'text', nullable: true })
  installed_sha!: string | null;

  /**
   * How a `git`-provenance skill updates: `pinned` (never auto-update, badge only), `track-ref`
   * (auto-update to `source_ref`'s remote head), `manual` (badge, one-click apply). Null for
   * `custom`/`managed`.
   */
  @Column({ type: 'text', nullable: true })
  update_policy!: SkillUpdatePolicy | null;

  /** Set when this skill was forked from a `git`-provenance skill via an edit (fork-to-custom); the
   *  original's `name`, for provenance display. Null for a never-forked skill. */
  @Column({ type: 'text', nullable: true })
  forked_from!: string | null;

  /**
   * Which turn surfaces this skill is active on. Plain-literal default (NOT a `()=>'…'::jsonb` expression)
   * so TypeORM's jsonb-aware default compare doesn't regenerate the migration forever. Filtered host-side
   * in `SkillResolver.resolveForTurn` against the current turn's surface. Defaults to build-only — most
   * skills shape how code is written, not how the brain plans.
   */
  @Column({ type: 'jsonb', default: ['build'] })
  surfaces!: McpSurface[];

  /** The ThreadType(s) whose review this skill's knowledge applies to (framework-conformance lens). Plain-literal
   *  default (NOT a `()=>'…'::jsonb` expression) so TypeORM's jsonb default-diff doesn't regenerate the migration
   *  forever — mirrors `surfaces`. A review-surface skill matches a thread when this includes the thread's type
   *  OR a `review_for_globs` entry matches a changed file. */
  @Column({ type: 'jsonb', default: [] })
  review_for_types!: string[];

  /** File globs (e.g. `**\/*.tsx`, `backend/**`) matched against a thread's changedFiles — the orthogonal,
   *  path-based applicability axis alongside {@link review_for_types}. Same plain-literal-default rationale. */
  @Column({ type: 'jsonb', default: [] })
  review_for_globs!: string[];

  /** Master on/off switch — a disabled skill is never resolved onto a turn. */
  @Column({ type: 'boolean', default: true })
  enabled!: boolean;

  /**
   * Set by `SkillUpdaterService` when a `pinned`/`manual` git skill's `source_ref` has moved past
   * `installed_sha` on the remote — the "update available" badge the list endpoint surfaces. Cleared back
   * to false the moment the skill is re-vendored (apply-now or a `track-ref` auto-update). Always false
   * for `custom`/`managed` skills.
   */
  @Column({ type: 'boolean', default: false })
  update_available!: boolean;
}

/** Where a skill dir came from — drives which source/update columns are meaningful. */
export type SkillProvenance = 'git' | 'custom' | 'managed';

/** Update behavior for a `git`-provenance skill (meaningless for `custom`/`managed`). */
export type SkillUpdatePolicy = 'pinned' | 'track-ref' | 'manual';
