import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  Get,
  Param,
  ParseUUIDPipe,
  Post,
  Put,
} from '@nestjs/common';
import { CurrentUser } from '@workspace/auth/server';
import {
  type AccountUsage,
  type AgentCredentialView,
  type ClaudeAuthorizeUrlResult,
  CodexDevicePollDto,
  type CodexDevicePollResult,
  type CodexDeviceStartResult,
  CreateClaudePersonalDto,
  CreateSetupTokenDto,
  PasteCodexAuthDto,
  SetSelectedDto,
} from '@workspace/shared';
import type { User } from '../../_lib/database/entities/user.entity';
import { OrgService } from '../org/org.service';
import { AgentCredentialService } from './agent-credential.service';
import { ClaudeOAuthClient, ClaudeOAuthHttpError } from './oauth/claude-oauth.client';
import { CodexAuthInvalidError } from './oauth/codex-auth-invalid.error';
import { CodexOAuthClient, CodexOAuthHttpError } from './oauth/codex-oauth.client';
import { OAuthDeviceStore } from './oauth/oauth-device.store';
import { OAuthPkceStore } from './oauth/oauth-pkce.store';
import { AgentUsageService } from './usage/agent-usage.service';

@Controller('orgs/:orgId/agent-credentials')
export class AgentCredentialsController {
  constructor(
    private readonly store: AgentCredentialService,
    private readonly usage: AgentUsageService,
    private readonly pkce: OAuthPkceStore,
    private readonly devices: OAuthDeviceStore,
    private readonly orgs: OrgService,
    private readonly claudeOAuth: ClaudeOAuthClient,
    private readonly codexOAuth: CodexOAuthClient,
  ) {}

  /** Start the Claude OAuth flow: returns the authorize URL to open and the state to echo back. */
  @Post('claude/authorize-url')
  async claudeAuthorizeUrl(
    @CurrentUser() user: User,
    @Param('orgId', ParseUUIDPipe) orgId: string,
  ): Promise<ClaudeAuthorizeUrlResult> {
    await this.orgs.assertOwner(user.id, orgId);
    const { verifier, challenge, state } = this.claudeOAuth.generatePkce();
    await this.pkce.stash(orgId, state, verifier);
    return { url: this.claudeOAuth.buildAuthorizeUrl({ challenge, state }), state };
  }

  /** Finish Claude OAuth from the pasted `code#state`. */
  @Post('claude/personal')
  async createClaudePersonal(
    @CurrentUser() user: User,
    @Param('orgId', ParseUUIDPipe) orgId: string,
    @Body() body: CreateClaudePersonalDto,
  ): Promise<AgentCredentialView> {
    await this.orgs.assertOwner(user.id, orgId);
    const verifier = await this.pkce.consume(orgId, body.state);
    if (!verifier) {
      throw new BadRequestException('OAuth session expired — start the Claude login again.');
    }
    let tokenSet;
    try {
      tokenSet = await this.claudeOAuth.exchangeCode({
        code: body.code.trim(),
        verifier,
        state: body.state,
      });
    } catch (err) {
      throw AgentCredentialsController.oauthBadRequest(err, 'Claude authorization failed.');
    }
    const row = await this.store.upsertClaudePersonal(orgId, tokenSet);
    void this.usage.pollClaudeUsage(orgId, row.id); // populate usage in the background
    return this.store.toView(row);
  }

  /** Add a Claude setup-token (`sk-ant-oat…`) account. */
  @Post('claude/setup-token')
  async createSetupToken(
    @CurrentUser() user: User,
    @Param('orgId', ParseUUIDPipe) orgId: string,
    @Body() body: CreateSetupTokenDto,
  ): Promise<AgentCredentialView> {
    await this.orgs.assertOwner(user.id, orgId);
    const token = body.setupToken.trim();
    if (!token.startsWith('sk-ant-oat')) {
      throw new BadRequestException('Not a Claude setup token (expected an `sk-ant-oat…` value).');
    }
    const row = await this.store.createClaudeSetupToken(orgId, token, body.label);
    return this.store.toView(row);
  }

  /** Start the Codex device-code login: returns the code + link to show and a handle to poll. */
  @Post('codex/device/start')
  async codexDeviceStart(
    @CurrentUser() user: User,
    @Param('orgId', ParseUUIDPipe) orgId: string,
  ): Promise<CodexDeviceStartResult> {
    await this.orgs.assertOwner(user.id, orgId);
    let device;
    try {
      device = await this.codexOAuth.startDeviceAuth();
    } catch (err) {
      throw AgentCredentialsController.oauthBadRequest(err, 'Could not start Codex device login.');
    }
    const handle = await this.devices.stash(
      { orgId, deviceAuthId: device.deviceAuthId, userCode: device.userCode },
      device.expiresIn,
    );
    return {
      handle,
      userCode: device.userCode,
      verificationUri: device.verificationUri,
      expiresIn: device.expiresIn,
      interval: device.intervalSec,
    };
  }

  /** Poll a running Codex device login; on completion the account is stored and returned. */
  @Post('codex/device/poll')
  async codexDevicePoll(
    @CurrentUser() user: User,
    @Param('orgId', ParseUUIDPipe) orgId: string,
    @Body() body: CodexDevicePollDto,
  ): Promise<CodexDevicePollResult> {
    await this.orgs.assertOwner(user.id, orgId);
    const state = await this.devices.get(body.handle, orgId);
    if (!state) return { status: 'expired' };
    try {
      const poll = await this.codexOAuth.pollDeviceOnce({
        deviceAuthId: state.deviceAuthId,
        userCode: state.userCode,
      });
      if (poll.pending) return { status: 'pending' };
      const tokens = await this.codexOAuth.exchangeDeviceCode({
        authorizationCode: poll.authorizationCode,
        codeVerifier: poll.codeVerifier,
      });
      const authJson = this.codexOAuth.buildAuthJson(tokens, new Date().toISOString());
      const row = await this.store.upsertCodexFromAuthJson(orgId, authJson);
      await this.devices.remove(body.handle);
      return { status: 'complete', credential: this.store.toView(row) };
    } catch (err) {
      if (err instanceof CodexOAuthHttpError) return { status: 'denied' };
      throw err;
    }
  }

  /** Add a Codex account by pasting `~/.codex/auth.json`. */
  @Post('codex/paste')
  async pasteCodexAuth(
    @CurrentUser() user: User,
    @Param('orgId', ParseUUIDPipe) orgId: string,
    @Body() body: PasteCodexAuthDto,
  ): Promise<AgentCredentialView> {
    await this.orgs.assertOwner(user.id, orgId);
    try {
      const row = await this.store.upsertCodexFromAuthJson(orgId, body.authJson.trim(), body.label);
      return this.store.toView(row);
    } catch (err) {
      if (err instanceof CodexAuthInvalidError) throw new BadRequestException(err.message);
      throw err;
    }
  }

  /** Make an account the active one for its provider. */
  @Put('selected')
  async setSelected(
    @CurrentUser() user: User,
    @Param('orgId', ParseUUIDPipe) orgId: string,
    @Body() body: SetSelectedDto,
  ): Promise<{ ok: true }> {
    await this.orgs.assertOwner(user.id, orgId);
    await this.store.setSelected(orgId, body.credentialId);
    return { ok: true };
  }

  @Delete(':id')
  async remove(
    @CurrentUser() user: User,
    @Param('orgId', ParseUUIDPipe) orgId: string,
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<{ ok: true }> {
    await this.orgs.assertOwner(user.id, orgId);
    await this.store.remove(orgId, id);
    return { ok: true };
  }

  /** On-demand fresh Claude usage poll for one account (members). Returns null for Codex / on failure. */
  @Get(':id/usage')
  async usageForCredential(
    @CurrentUser() user: User,
    @Param('orgId', ParseUUIDPipe) orgId: string,
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<AccountUsage | null> {
    await this.orgs.assertMember(user.id, orgId);
    return this.usage.pollClaudeUsage(orgId, id);
  }

  private static oauthBadRequest(err: unknown, fallback: string): BadRequestException {
    if (err instanceof ClaudeOAuthHttpError || err instanceof CodexOAuthHttpError) {
      return new BadRequestException(`${fallback} (HTTP ${err.status})`);
    }
    if (err instanceof Error) return new BadRequestException(err.message);
    return new BadRequestException(fallback);
  }
}
