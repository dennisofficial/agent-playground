import { Column, Entity, Index, JoinColumn, ManyToOne, PrimaryColumn } from 'typeorm';
import { TimestampedEntity } from '@workspace/shared/schemas';
import { OrganizationEntity } from './organization.entity';
import type { McpSurface } from './mcp-server.entity';

/**
 * A user/brain-defined SKILL — a named, reusable `SKILL.md` (a short instruction the in-sandbox engine
 * loads on demand, like a Claude Code skill) that shapes how a build/brain/review session works on a
 * matching repo. Resolved host-side per turn by `SkillResolver` and threaded onto the turn spec
 * (`RunEngineArgs.skills`); the in-container entrypoint renders each into a `SKILL.md` on disk the SDK
 * discovers.
 *
 * Composite PK (org_id, scope, name) mirrors {@link McpServerEntity} exactly:
 *   - `scope='*'` → an ORG-level skill, active for every repo/job in the org.
 *   - `scope=<repoId>` → a REPO-level skill, active only for that repo (and OVERRIDES an org skill of the
 *     same `name` on a collision — see `SkillResolver.resolveForTurn`).
 *
 * Unlike {@link McpServerEntity} there are NO secrets here — a skill is plain markdown — so there is no
 * `secrets_enc` / encryption. `description` is the skill's trigger blurb (the SKILL.md frontmatter
 * `description`, what the model reads to decide when to load it); `body` is the skill's markdown content.
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

  /** The skill's markdown content (the SKILL.md body). Poured verbatim into the rendered SKILL.md. */
  @Column({ type: 'text' })
  body!: string;

  /**
   * Which turn surfaces this skill is active on. Plain-literal default (NOT a `()=>'…'::jsonb` expression)
   * so TypeORM's jsonb-aware default compare doesn't regenerate the migration forever. Filtered host-side
   * in `SkillResolver.resolveForTurn` against the current turn's surface. Defaults to build-only — most
   * skills shape how code is written, not how the brain plans.
   */
  @Column({ type: 'jsonb', default: ['build'] })
  surfaces!: McpSurface[];

  /** Master on/off switch — a disabled skill is never resolved onto a turn. */
  @Column({ type: 'boolean', default: true })
  enabled!: boolean;
}
