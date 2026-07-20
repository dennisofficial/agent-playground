import { Body, Controller, Get, Param, ParseUUIDPipe, Put } from '@nestjs/common';
import { CurrentUser } from '@workspace/auth/server';
import {
  type CredentialPresence,
  SaveCredentialsDto,
  type SaveCredentialsResult,
} from '@workspace/shared';
import type { User } from '../../_lib/database/entities/user.entity';
import { OrgService } from '../org/org.service';
import { OrgCredentialsService } from './credentials.service';

/**
 * The org's API keys (Anthropic / OpenAI / GitHub PAT). Both ops are inherently org-scoped (the keys are
 * a single row keyed by orgId), so the org stays in the path — like the repo module's collection ops.
 * Reads require membership and return presence only; writes require ownership. Values are never returned.
 */
@Controller('orgs/:orgId/credentials')
export class OrgCredentialsController {
  constructor(
    private readonly credentials: OrgCredentialsService,
    private readonly orgs: OrgService,
  ) {}

  /** Presence of each API key. Members can read; values are never returned. */
  @Get()
  async presence(
    @CurrentUser() user: User,
    @Param('orgId', ParseUUIDPipe) orgId: string,
  ): Promise<CredentialPresence> {
    await this.orgs.assertMember(user.id, orgId);
    return this.credentials.presence(orgId);
  }

  /** Save API keys. Owner-only. Blank/omitted fields are left untouched. */
  @Put()
  async save(
    @CurrentUser() user: User,
    @Param('orgId', ParseUUIDPipe) orgId: string,
    @Body() body: SaveCredentialsDto,
  ): Promise<SaveCredentialsResult> {
    await this.orgs.assertOwner(user.id, orgId);
    await this.credentials.save(orgId, {
      anthropicApiKey: body.anthropicApiKey?.trim() || undefined,
      openaiApiKey: body.openaiApiKey?.trim() || undefined,
      githubPat: body.githubPat?.trim() || undefined,
    });
    return { ok: true };
  }
}
