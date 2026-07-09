import { Column, Entity, Index, JoinColumn, ManyToOne, PrimaryGeneratedColumn, Unique } from 'typeorm';
import { TimestampedEntity } from '@workspace/shared/schemas';
import { OrganizationEntity } from './organization.entity';
import { RepoEntity } from './repo.entity';

/**
 * THE ADR MANIFEST (Phase 2) — the GRAPH + FRESHNESS source of truth for a repo's durable `.atlas/adr/`
 * records. The committed `.md` files hold the PROSE; this row holds the metadata the management layer must
 * own to keep the ADR store consistent: the canonical (merged) status, the
 * supersession graph, the paths a decision governs, and a tamper-resistant `content_hash` baseline for
 * human-edit detection (which CANNOT live in the file the human edits — it would be circular).
 *
 * Populated + healed by `reconcileFromBaseCheckout` (run on PR merge for the merged repo, and on boot for
 * all repos): it reads the MERGED default-branch ADRs, upserts a row per file, resolves supersession,
 * and — when a file's hash diverges from this baseline by a NON-Atlas author — sets {@link flagged} and
 * leaves the row alone (never silently overwrites or auto-trusts a human edit). One row per
 * `(org, repo, slug)`; outlives the thread that authored it (so `source_job` is a plain id, not an FK).
 */
@Entity({ name: 'repo_adrs' })
@Index(['org_id', 'repo_id'])
@Unique(['org_id', 'repo_id', 'slug'])
export class RepoAdrEntity extends TimestampedEntity {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  /** The tenant (FK → organizations.id). */
  @Column({ type: 'uuid' })
  org_id!: string;

  @ManyToOne(() => OrganizationEntity, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'org_id' })
  org?: OrganizationEntity;

  /** The repo whose ADR manifest this belongs to (FK → repos.id). */
  @Column({ type: 'uuid' })
  repo_id!: string;

  @ManyToOne(() => RepoEntity, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'repo_id' })
  repo?: RepoEntity;

  /** Stable topic slug = the `.atlas/adr/<slug>.md` filename + the file's frontmatter `id`. */
  @Column({ type: 'text' })
  slug!: string;

  /** The decision title (mirrors the file frontmatter — denormalized for cheap listing). */
  @Column({ type: 'text', default: '' })
  title!: string;

  /**
   * The AUTHORITATIVE status (Phase 1 trusted file-presence; here the manifest is canonical). A row exists
   * only for a MERGED decision, so it is `accepted` unless its frontmatter marks it `superseded`.
   */
  @Column({ type: 'text', default: 'accepted' })
  status!: string;

  /** Free-text tags from the file frontmatter (no fixed taxonomy). */
  @Column({ type: 'text', array: true, default: () => `'{}'` })
  tags!: string[];

  /** The thread that authored this decision (a plain id — the ADR OUTLIVES the thread, so NOT an FK). */
  @Column({ type: 'text', nullable: true })
  source_job!: string | null;

  /** Slugs this decision replaces (the supersession graph; resolved from frontmatter on reconcile). */
  @Column({ type: 'text', array: true, default: () => `'{}'` })
  supersedes!: string[];

  /** The slug that replaced this one, or null while it is current. */
  @Column({ type: 'text', nullable: true })
  superseded_by!: string | null;

  /** Globs the decision constrains — the hook the Phase 3 drift detector scopes a diff against. */
  @Column({ type: 'text', array: true, default: () => `'{}'` })
  governs_paths!: string[];

  /** sha256 of the merged file contents — the baseline reconcile compares against to spot a human edit. */
  @Column({ type: 'text', default: '' })
  content_hash!: string;

  /**
   * Set when reconcile finds the merged file changed by a NON-Atlas author since {@link content_hash} —
   * a human edit awaiting operator review. The row is NOT overwritten while flagged (never auto-trust).
   */
  @Column({ type: 'boolean', default: false })
  flagged!: boolean;

  /** When the manifest row was last reconciled against the merged base checkout. */
  @Column({ type: 'timestamptz', nullable: true })
  last_reconciled!: Date | null;
}
