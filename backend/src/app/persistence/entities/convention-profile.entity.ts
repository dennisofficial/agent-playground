import {
  Column,
  Entity,
  Index,
  JoinColumn,
  ManyToOne,
  PrimaryColumn,
} from 'typeorm';
import { TimestampedEntity } from '@workspace/shared/schemas';
import { OrganizationEntity } from './organization.entity';

/**
 * A reusable, operator-defined HOUSE-STYLE profile — a named bundle of coding conventions (folder
 * structure, architecture idioms, stack rules) authored ONCE per org and attached to any number of repos
 * via `RepoEntity.convention_profile_slug`. When a repo points at a profile, its `body` is injected into
 * every build-facing prompt (brain, workers, review/fix) inside a fixed Atlas-owned envelope — see
 * `prompt-kit/system/groups/conventions.group.ts`. A repo with NO pointer gets nothing extra, so a profile can
 * never misfire on a repo that doesn't follow the style.
 *
 * Composite PK (org_id, slug) mirrors {@link McpServerEntity} — `slug` is the stable identity the repo
 * pointer and the onboarding brain's `propose_convention_profile` reference; `name` is display-only.
 */
@Entity({ name: 'convention_profiles' })
@Index(['org_id'])
export class ConventionProfileEntity extends TimestampedEntity {
  /** The owning org (FK → organizations). */
  @PrimaryColumn({ type: 'uuid' })
  org_id!: string;

  @ManyToOne(() => OrganizationEntity, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'org_id' })
  org?: OrganizationEntity;

  /** URL-safe stable identity, unique within the org — what a repo pointer and the onboarding brain reference. */
  @PrimaryColumn({ type: 'text' })
  slug!: string;

  /** Display name (e.g. "NestJS + Next.js + shared contract"). */
  @Column({ type: 'text' })
  name!: string;

  /** The house-style rules, markdown. Poured verbatim into the prompt envelope as DATA (never as a hardcoded fragment). */
  @Column({ type: 'text' })
  body!: string;

  /**
   * A natural-language description of WHICH stack/shape this profile matches (e.g. "NestJS backend + Next.js
   * app-router frontend + a shared/ contract dir"). The onboarding brain reads this via
   * `list_convention_profiles` and compares it against the stack it mapped, to propose the best match (or
   * `none`). Display + matching only — never injected into a build prompt.
   */
  @Column({ type: 'text', nullable: true })
  detect_hint!: string | null;
}
