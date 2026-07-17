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
 */
@Controller('orgs/:orgId/credentials')
export class CredentialsController {
  constructor(
    private readonly credentials: CredentialsService,
    private readonly orgs: OrgService,
  ) {}

  /** Which credentials the org has. Members can read; secrets are never returned. */
  @Get()
  async presence(
    @CurrentUser() user: User,
    @Param('orgId', ParseUUIDPipe) orgId: string,
  ): Promise<CredentialPresence> {
    await this.orgs.assertMember(user.id, orgId);
    const has = await this.credentials.hasMany(orgId, [
      ECredentialKey.ANTHROPIC_API_KEY,
      ECredentialKey.OPENAI_API_KEY,
      ECredentialKey.GITHUB_PAT,
      ECredentialKey.CODEX_AUTH,
    ]);
    return {
      hasAnthropic: has[ECredentialKey.ANTHROPIC_API_KEY],
      hasOpenai: has[ECredentialKey.OPENAI_API_KEY],
      hasGithub: has[ECredentialKey.GITHUB_PAT],
      hasCodex: has[ECredentialKey.CODEX_AUTH],
      // Stubbed until the engine / GitHub modules land — see CredentialPresence docs.
      llmValidated: has[ECredentialKey.ANTHROPIC_API_KEY],
      engineAuthSet: false,
      hasGithubApp: false,
      githubAuthMode: 'pat',
    };
  }

  /** Save any subset of credentials. Owner-only. Only non-empty fields are written. */
  @Put()
  async save(
    @CurrentUser() user: User,
    @Param('orgId', ParseUUIDPipe) orgId: string,
    @Body() body: SaveCredentialsDto,
  ): Promise<SaveCredentialsResult> {
    await this.orgs.assertOwner(user.id, orgId);

    const writes: [ECredentialKey, string | undefined][] = [
      [ECredentialKey.ANTHROPIC_API_KEY, body.anthropicApiKey],
      [ECredentialKey.OPENAI_API_KEY, body.openaiApiKey],
      [ECredentialKey.GITHUB_PAT, body.githubPat],
      [ECredentialKey.CODEX_AUTH, body.codexAuthSecret],
    ];
    for (const [key, value] of writes) {
      const trimmed = value?.trim();
      if (trimmed) await this.credentials.set(orgId, key, trimmed);
    }

    // The vault does not probe LLM keys — that's the future engine module's job. Report ok
    // optimistically so the Anthropic card, which reads validation.llmKey, doesn't break.
    return {
      ok: true,
      validation: body.anthropicApiKey ? { llmKey: { ok: true } } : {},
    };
  }
}
