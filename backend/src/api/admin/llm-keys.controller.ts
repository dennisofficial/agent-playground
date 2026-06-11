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
import { isLlmProvider, type LlmProvider } from '../../harness/llm-keys/llm-key.types';
import { ProviderKeyStore } from '../../harness/llm-keys/provider-key.store';
import { SecretCipher } from '../../harness/projects/secret-cipher';
import { AdminTokenGuard } from './admin-token.guard';
import { PutLlmKeyDto } from './dto/llm-key.dto';

/**
 * Admin CRUD for tenant LLM provider keys ('anthropic' | 'openai'). WRITE-ONLY for values: every
 * response is metadata (provider/timestamps) — a stored key can be rotated or deleted, never read
 * back. Jarvis's keys modal and the web admin are both clients of this same store; a key landing
 * here flips the harness process out of pending-keys mode within one readiness poll.
 */
@Controller('llm-keys')
@UseGuards(AdminTokenGuard)
export class LlmKeysController {
  constructor(
    private readonly keys: ProviderKeyStore,
    private readonly cipher: SecretCipher,
  ) {}

  private parseProvider(provider: string): LlmProvider {
    if (!isLlmProvider(provider)) {
      throw new BadRequestException(
        `Unknown provider "${provider}" — expected 'anthropic' or 'openai'.`,
      );
    }
    return provider;
  }

  @Put(':provider')
  async put(@Param('provider') provider: string, @Body() dto: PutLlmKeyDto) {
    if (!this.cipher.isConfigured()) {
      throw new BadRequestException(
        'SECRETS_ENCRYPTION_KEY is not set — generate one with `openssl rand -base64 32` before storing keys.',
      );
    }
    return this.keys.put(this.parseProvider(provider), dto.key);
  }

  @Get()
  list() {
    return this.keys.listMeta();
  }

  @Delete(':provider')
  async remove(@Param('provider') provider: string) {
    await this.keys.delete(this.parseProvider(provider));
    return { ok: true };
  }
}
