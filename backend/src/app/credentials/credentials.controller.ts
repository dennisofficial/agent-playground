import { Body, Controller, Get, Param, ParseUUIDPipe, Put } from '@nestjs/common';
import { CurrentUser } from '@workspace/auth/server';
import {
  type CredentialPresence,
  ECredentialKey,
  SaveCredentialsDto,
  type SaveCredentialsResult,
} from '@workspace/shared';
import type { User } from '../auth/entities/user.entity';
import { OrgService } from '../org/org.service';
import { CredentialsService } from './credentials.service';

/**
 * The org's credential collection. Both ops are inherently in an org's context (there's no per-secret
 * UUID — a secret is keyed by `(orgId, key)`), so the org stays in the path, exactly like the repo
 * module's {@link OrgRepoController} keeps `orgs/:orgId/repos` for its collection ops. Reads require
 * membership, writes require ownership; secrets are never returned.
 *
 * KEY-AGNOSTIC: this surface only ever speaks {@link ECredentialKey} — it has no idea what "anthropic"
 * or "github" mean. Consumers map keys to their own domain view.
 */
@Controller('orgs/:orgId/credentials')
export class CredentialsController {
  constructor(
    private readonly credentials: CredentialsService,
    private readonly orgs: OrgService,
  ) {}

  /** Presence of every credential key for the org. Members can read; values are never returned. */
  @Get()
  async presence(
    @CurrentUser() user: User,
    @Param('orgId', ParseUUIDPipe) orgId: string,
  ): Promise<CredentialPresence> {
    await this.orgs.assertMember(user.id, orgId);
    const present = await this.credentials.hasMany(orgId, Object.values(ECredentialKey));
    return { present };
  }

  /** Save a batch of secrets. Owner-only. Empty values are skipped. */
  @Put()
  async save(
    @CurrentUser() user: User,
    @Param('orgId', ParseUUIDPipe) orgId: string,
    @Body() body: SaveCredentialsDto,
  ): Promise<SaveCredentialsResult> {
    await this.orgs.assertOwner(user.id, orgId);
    const writes = body.entries
      .map((e) => ({ key: e.key, plaintext: e.value.trim() }))
      .filter((e) => e.plaintext);
    await this.credentials.setMany(orgId, writes);
    return { ok: true };
  }
}
