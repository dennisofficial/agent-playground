import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Put,
  UseGuards,
} from '@nestjs/common';
import { IsOptional, IsString, MinLength } from 'class-validator';
import { CurrentOrg, type CurrentOrgCtx } from '../org/current-org.decorator';
import { OrgMembershipGuard } from '../org/org-membership.guard';
import { OrgOwnerGuard } from '../org/org-owner.guard';
import { ConventionProfileResolver } from './convention-profile.resolver';

const SLUG_RE = /^[a-z0-9][a-z0-9_-]{0,63}$/;

class SetConventionProfileDto {
  @IsString() @MinLength(1) name!: string;
  @IsString() @MinLength(1) body!: string;
  @IsOptional() @IsString() detectHint?: string;
}

class AttachConventionProfileDto {
  @IsOptional() @IsString() slug?: string | null;
}

@Controller('web/orgs/:orgId/convention-profiles')
@UseGuards(OrgMembershipGuard)
export class ConventionProfilesController {
  constructor(private readonly conventions: ConventionProfileResolver) {}

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

  @Get('repo/:repoId')
  async attached(
    @CurrentOrg() org: CurrentOrgCtx,
    @Param('repoId') repoId: string,
  ): Promise<{ slug: string | null }> {
    return { slug: await this.conventions.attachedSlug(org.id, repoId) };
  }

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

  @Delete(':slug')
  @UseGuards(OrgOwnerGuard)
  async remove(
    @CurrentOrg() org: CurrentOrgCtx,
    @Param('slug') slug: string,
  ): Promise<{ ok: boolean }> {
    await this.conventions.deleteProfile(org.id, slug);
    return { ok: true };
  }

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
