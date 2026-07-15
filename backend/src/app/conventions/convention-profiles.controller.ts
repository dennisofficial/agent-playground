import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Put,
  UseGuards,
  UsePipes,
  ValidationPipe,
} from '@nestjs/common';
import { IsOptional, IsString, MinLength } from 'class-validator';
import { CurrentOrg, type CurrentOrgCtx } from '../org/current-org.decorator';
import { OrgMembershipGuard } from '../org/org-membership.guard';
import { OrgOwnerGuard } from '../org/org-owner.guard';
import { ConventionProfileResolver } from './convention-profile.resolver';

/** URL-safe slug for a profile (mirrors the MCP server name rule). */
const SLUG_RE = /^[a-z0-9][a-z0-9_-]{0,63}$/;

class SetConventionProfileDto {
  @IsString() @MinLength(1) name!: string;
  @IsString() @MinLength(1) body!: string;
  @IsOptional() @IsString() detectHint?: string;
}

class AttachConventionProfileDto {
  /** The profile slug to attach, or null/absent to CLEAR the repo's house style. */
  @IsOptional() @IsString() slug?: string | null;
}

/**
 * `/web/orgs/:orgId/convention-profiles` — manage the org's reusable house-style profiles and attach one to a
 * repo. Mirrors {@link McpServersController}: GET is readable by any member; all mutations are an Administer
 * action (owner only, `OrgOwnerGuard`). The `repo/:repoId` sub-routes read/set `repos.convention_profile_slug`
 * (the same pointer the onboarding brain's owner-gated proposal commits). No secrets here — the body is plain.
 */
@Controller('web/orgs/:orgId/convention-profiles')
@UseGuards(OrgMembershipGuard)
@UsePipes(new ValidationPipe({ whitelist: true, transform: true }))
export class ConventionProfilesController {
  constructor(private readonly conventions: ConventionProfileResolver) {}

  /** List every profile (with body) for the org — the console editor's data. */
  @Get()
  async list(@CurrentOrg() org: CurrentOrgCtx): Promise<{
    profiles: {
      slug: string;
      name: string;
      body: string;
      detectHint: string | null;
    }[];
  }> {
    return { profiles: await this.conventions.allProfiles(org.id) };
  }

  /** The slug currently attached to a repo (or null) — the repo-settings control's initial state. */
  @Get('repo/:repoId')
  async attached(
    @CurrentOrg() org: CurrentOrgCtx,
    @Param('repoId') repoId: string,
  ): Promise<{ slug: string | null }> {
    return { slug: await this.conventions.attachedSlug(org.id, repoId) };
  }

  /** Create or update a profile (owner only). Slug comes from the URL and must be URL-safe. */
  @Put(':slug')
  @UseGuards(OrgOwnerGuard)
  async set(
    @CurrentOrg() org: CurrentOrgCtx,
    @Param('slug') slug: string,
    @Body() body: SetConventionProfileDto,
  ): Promise<{ ok: boolean }> {
    if (!SLUG_RE.test(slug)) {
      throw new BadRequestException(
        'slug must be lowercase letters/digits/_/- (e.g. nestjs-next-shared)',
      );
    }
    await this.conventions.upsertProfile(org.id, slug, {
      name: body.name,
      body: body.body,
      detectHint: body.detectHint ?? null,
    });
    return { ok: true };
  }

  /** Delete a profile (owner only). Repos still pointing at it resolve to "no house style" (dangling → null). */
  @Delete(':slug')
  @UseGuards(OrgOwnerGuard)
  async remove(
    @CurrentOrg() org: CurrentOrgCtx,
    @Param('slug') slug: string,
  ): Promise<{ ok: boolean }> {
    await this.conventions.deleteProfile(org.id, slug);
    return { ok: true };
  }

  /** Attach a profile to a repo, or clear it with `{ slug: null }` (owner only). Scope forced to (org, repo). */
  @Put('repo/:repoId')
  @UseGuards(OrgOwnerGuard)
  async attach(
    @CurrentOrg() org: CurrentOrgCtx,
    @Param('repoId') repoId: string,
    @Body() body: AttachConventionProfileDto,
  ): Promise<{ ok: boolean; slug: string | null }> {
    const slug = body.slug ? body.slug.trim() : null;
    try {
      await this.conventions.attach(org.id, repoId, slug);
    } catch (err) {
      throw new BadRequestException((err as Error).message);
    }
    return { ok: true, slug };
  }
}
