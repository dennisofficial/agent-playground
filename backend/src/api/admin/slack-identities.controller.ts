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
import { SecretCipher } from '../../harness/projects/secret-cipher';
import { SlackIdentityStore } from '../../harness/slack-identities/slack-identity.store';
import { AdminAuthGuard } from '../auth/admin-auth.guard';
import { PutSlackIdentityDto } from './dto/slack-identity.dto';

/** Roster employee id shape — the api app is harness-free (no EmployeeRegistry), so this is the
 * only gate; a token stored under an unknown id is simply never resolved by the slack-app. */
const BOT_ID = /^[a-z0-9][a-z0-9._-]*$/;

/**
 * Admin CRUD for per-employee Slack puppet-app tokens. WRITE-ONLY for values: every response is
 * metadata (botId/timestamps) — a stored token can be rotated or deleted, never read back. A
 * token landing here routes that employee's posts/reactions through their own bot user within
 * one registry TTL (≤60s for a fresh id, ≤10min for a rotation).
 */
@Controller('tenants/:teamId/slack-identities')
@UseGuards(AdminAuthGuard)
export class SlackIdentitiesController {
  constructor(
    private readonly identities: SlackIdentityStore,
    private readonly cipher: SecretCipher,
  ) {}

  private parseBotId(botId: string): string {
    if (!BOT_ID.test(botId)) {
      throw new BadRequestException(
        'botId must be lowercase alphanumeric (dot/dash/underscore allowed)',
      );
    }
    return botId;
  }

  @Put(':botId')
  async put(
    @Param('teamId') teamId: string,
    @Param('botId') botId: string,
    @Body() dto: PutSlackIdentityDto,
  ) {
    if (!this.cipher.isConfigured()) {
      throw new BadRequestException(
        'SECRETS_ENCRYPTION_KEY is not set — generate one with `openssl rand -base64 32` before storing tokens.',
      );
    }
    return this.identities.put(teamId, this.parseBotId(botId), dto.token);
  }

  @Get()
  list(@Param('teamId') teamId: string) {
    return this.identities.listMeta(teamId);
  }

  @Delete(':botId')
  async remove(@Param('teamId') teamId: string, @Param('botId') botId: string) {
    await this.identities.delete(teamId, this.parseBotId(botId));
    return { ok: true };
  }
}
