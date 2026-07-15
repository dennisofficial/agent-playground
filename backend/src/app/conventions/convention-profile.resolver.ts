import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { DB_CONNECTION } from '../persistence/database.module';
import { ConventionProfileEntity, RepoEntity } from '../persistence/entities';

/** The resolved house-style, ready to pour into a prompt envelope. */
export interface ResolvedConventions {
  name: string;
  body: string;
}

/** A profile as listed for the console / the onboarding brain's stack-matching (no secret content here). */
export interface ProfileSummary {
  slug: string;
  name: string;
  detectHint: string | null;
}

/**
 * Resolves a repo's opt-in house-style profile for a turn, and owns the small CRUD around
 * {@link ConventionProfileEntity} + the `repos.convention_profile_slug` pointer.
 *
 * The ONLY reader on the hot path is {@link resolveForRepo}: turn-assembly (brain / driver / autofix)
 * calls it, and threads the result into `ctx.settings.repoConventions` (host-assembled prompts) and
 * `RunEngineArgs.repoConventions` (engine-assembled subagents). A repo with no pointer — or a dangling
 * pointer to a deleted profile — resolves to `null`, so the conventions fragment self-drops and nothing
 * is injected. No secrets, so this is plain text (unlike {@link McpServerStore}).
 */
@Injectable()
export class ConventionProfileResolver {
  private readonly logger = new Logger(ConventionProfileResolver.name);

  constructor(
    @InjectRepository(ConventionProfileEntity, DB_CONNECTION)
    private readonly profiles: Repository<ConventionProfileEntity>,
    @InjectRepository(RepoEntity, DB_CONNECTION)
    private readonly repos: Repository<RepoEntity>,
  ) {}

  /**
   * The repo's attached house-style, or `null` when none is attached (or the pointer dangles to a
   * removed profile). This is the misfire guard: no attachment ⇒ no injection.
   */
  async resolveForRepo(
    orgId: string,
    repoId: string,
  ): Promise<ResolvedConventions | null> {
    const repo = await this.repos.findOne({
      where: { id: repoId, org_id: orgId },
    });
    const slug = repo?.convention_profile_slug;
    if (!slug) return null;
    const profile = await this.profiles.findOne({
      where: { org_id: orgId, slug },
    });
    if (!profile || !profile.body.trim()) {
      if (!profile) {
        this.logger.warn(
          `repo ${repoId} points at missing convention profile "${slug}" — treating as none`,
        );
      }
      return null;
    }
    return { name: profile.name, body: profile.body };
  }

  /** Every profile for an org (slug/name/detect_hint) — for the onboarding brain to match against + the console. */
  async listProfiles(orgId: string): Promise<ProfileSummary[]> {
    const rows = await this.profiles.find({
      where: { org_id: orgId },
      order: { slug: 'ASC' },
    });
    return rows.map((r) => ({
      slug: r.slug,
      name: r.name,
      detectHint: r.detect_hint,
    }));
  }

  /** Every profile for an org WITH its body — for the console editor (no secrets here, so the body is fine). */
  async allProfiles(
    orgId: string,
  ): Promise<
    { slug: string; name: string; body: string; detectHint: string | null }[]
  > {
    const rows = await this.profiles.find({
      where: { org_id: orgId },
      order: { slug: 'ASC' },
    });
    return rows.map((r) => ({
      slug: r.slug,
      name: r.name,
      body: r.body,
      detectHint: r.detect_hint,
    }));
  }

  /** The slug currently attached to a repo (or null) — for the console repo-settings control. */
  async attachedSlug(orgId: string, repoId: string): Promise<string | null> {
    const repo = await this.repos.findOne({
      where: { id: repoId, org_id: orgId },
    });
    return repo?.convention_profile_slug ?? null;
  }

  /** One full profile, or null. */
  async getProfile(
    orgId: string,
    slug: string,
  ): Promise<ConventionProfileEntity | null> {
    return this.profiles.findOne({ where: { org_id: orgId, slug } });
  }

  /** Upsert a profile (the seed path + a future console editor). */
  async upsertProfile(
    orgId: string,
    slug: string,
    input: { name: string; body: string; detectHint?: string | null },
  ): Promise<void> {
    const row =
      (await this.profiles.findOne({ where: { org_id: orgId, slug } })) ??
      this.profiles.create({ org_id: orgId, slug });
    row.name = input.name;
    row.body = input.body;
    row.detect_hint = input.detectHint ?? null;
    await this.profiles.save(row);
    this.logger.log(`upserted convention profile org=${orgId} slug=${slug}`);
  }

  async deleteProfile(orgId: string, slug: string): Promise<void> {
    await this.profiles.delete({ org_id: orgId, slug });
  }

  /**
   * Attach a profile to a repo (or clear it with `null`). Attaching validates the slug exists in the org —
   * a bad slug throws rather than silently pointing a repo at nothing. This is the commit the owner-gated
   * `propose_convention_profile` approval (and a future console control) calls.
   */
  async attach(
    orgId: string,
    repoId: string,
    slug: string | null,
  ): Promise<void> {
    if (slug) {
      const profile = await this.profiles.findOne({
        where: { org_id: orgId, slug },
      });
      if (!profile) {
        throw new Error(
          `convention profile "${slug}" does not exist in org ${orgId}`,
        );
      }
    }
    await this.repos.update(
      { id: repoId, org_id: orgId },
      { convention_profile_slug: slug },
    );
    this.logger.log(
      `attached convention profile org=${orgId} repo=${repoId} slug=${slug ?? '(none)'}`,
    );
  }
}
