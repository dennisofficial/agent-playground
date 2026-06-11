import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Post,
  Put,
  UseGuards,
} from '@nestjs/common';
import { GithubTokenStore } from '../../harness/projects/github-token-store';
import { SecretCipher } from '../../harness/projects/secret-cipher';
import { AdminTokenGuard } from './admin-token.guard';
import { PutTokenDto } from './dto/token.dto';

/**
 * Admin CRUD for the GitHub token store. WRITE-ONLY for values: every response is metadata
 * (name/isDefault/timestamps) — a stored token can be rotated or deleted, never read back.
 */
@Controller('tenants/:teamId/tokens')
@UseGuards(AdminTokenGuard)
export class TokensController {
  constructor(
    private readonly tokens: GithubTokenStore,
    private readonly cipher: SecretCipher,
  ) {}

  @Post()
  async put(@Param('teamId') teamId: string, @Body() dto: PutTokenDto) {
    if (!this.cipher.isConfigured()) {
      throw new BadRequestException(
        'SECRETS_ENCRYPTION_KEY is not set — generate one with `openssl rand -base64 32` before storing tokens.',
      );
    }
    return this.tokens.put(teamId, dto.name, dto.token, dto.default);
  }

  @Get()
  list(@Param('teamId') teamId: string) {
    return this.tokens.listMeta(teamId);
  }

  @Put(':name/default')
  async setDefault(
    @Param('teamId') teamId: string,
    @Param('name') name: string,
  ) {
    try {
      await this.tokens.setDefault(teamId, name);
    } catch (err) {
      throw new BadRequestException(
        err instanceof Error ? err.message : String(err),
      );
    }
    return { ok: true };
  }

  @Delete(':name')
  async remove(@Param('teamId') teamId: string, @Param('name') name: string) {
    try {
      await this.tokens.delete(teamId, name);
    } catch (err) {
      throw new BadRequestException(
        err instanceof Error ? err.message : String(err),
      );
    }
    return { ok: true };
  }
}
