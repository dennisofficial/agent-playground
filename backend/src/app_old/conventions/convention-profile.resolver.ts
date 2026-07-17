import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { DB_CONNECTION } from '../persistence/database.module';
import { ConventionProfileEntity, RepoEntity } from '../persistence/entities';

export interface ResolvedConventions {
  name: string;
  body: string;
}

export interface ProfileSummary {
  slug: string;
  name: string;
  detectHint: string | null;
}

@Injectable()
export class ConventionProfileResolver {
  private readonly logger = new Logger(ConventionProfileResolver.name);

  constructor(
    @InjectRepository(ConventionProfileEntity, DB_CONNECTION)
    private readonly profiles: Repository<ConventionProfileEntity>,
    @InjectRepository(RepoEntity, DB_CONNECTION)
    private readonly repos: Repository<RepoEntity>,
  ) {}

  async resolveForRepo(orgId: string, repoId: string): Promise<ResolvedConventions | null> {
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

  async allProfiles(
    orgId: string,
  ): Promise<{ slug: string; name: string; body: string; detectHint: string | null }[]> {
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

  async attachedSlug(orgId: string, repoId: string): Promise<string | null> {
    const repo = await this.repos.findOne({
      where: { id: repoId, org_id: orgId },
    });
    return repo?.convention_profile_slug ?? null;
  }

  async getProfile(orgId: string, slug: string): Promise<ConventionProfileEntity | null> {
    return this.profiles.findOne({ where: { org_id: orgId, slug } });
  }

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

  async attach(orgId: string, repoId: string, slug: string | null): Promise<void> {
    if (slug) {
      const profile = await this.profiles.findOne({
        where: { org_id: orgId, slug },
      });
      if (!profile) {
        throw new Error(`convention profile "${slug}" does not exist in org ${orgId}`);
      }
    }
    await this.repos.update({ id: repoId, org_id: orgId }, { convention_profile_slug: slug });
    this.logger.log(
      `attached convention profile org=${orgId} repo=${repoId} slug=${slug ?? '(none)'}`,
    );
  }
}
