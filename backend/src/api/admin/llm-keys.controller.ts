import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Put,
} from '@nestjs/common';
import {
  isLlmProvider,
  type LlmProvider,
} from '../../harness/llm-keys/llm-key.types';
import { ProviderKeyStore } from '../../harness/llm-keys/provider-key.store';
import { SecretCipher } from '../../harness/projects/secret-cipher';
import { PutLlmKeyDto, PutSubscriptionDto } from './dto/llm-key.dto';

/**
 * Admin CRUD for tenant LLM provider keys ('anthropic' | 'openai'). WRITE-ONLY for values: every
 * response is metadata (provider/timestamps) — a stored key can be rotated or deleted, never read
 * back. The onboarding guard's keys modal and the web admin are both clients of this same store; a key landing
 * here flips the harness process out of pending-keys mode within one readiness poll.
 */
@Controller('tenants/:teamId/llm-keys')
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
  async put(
    @Param('teamId') teamId: string,
    @Param('provider') provider: string,
    @Body() dto: PutLlmKeyDto,
  ) {
    if (!this.cipher.isConfigured()) {
      throw new BadRequestException(
        'SECRETS_ENCRYPTION_KEY is not set — generate one with `openssl rand -base64 32` before storing keys.',
      );
    }
    return this.keys.put(teamId, this.parseProvider(provider), dto.key);
  }

  /** Set the engine auth MODE and (optionally) the subscription credential for a provider. Lets a
   * workspace drive its coding-engine turns off its own Claude Max / ChatGPT plan instead of the
   * metered API key (which still funds chat/gate/embeddings). WRITE-ONLY for the secret. */
  @Put(':provider/subscription')
  async putSubscription(
    @Param('teamId') teamId: string,
    @Param('provider') provider: string,
    @Body() dto: PutSubscriptionDto,
  ) {
    if (dto.secret !== undefined && !this.cipher.isConfigured()) {
      throw new BadRequestException(
        'SECRETS_ENCRYPTION_KEY is not set — generate one with `openssl rand -base64 32` before storing credentials.',
      );
    }
    return this.keys.putSubscription(
      teamId,
      this.parseProvider(provider),
      dto.mode,
      dto.secret,
    );
  }

  @Get()
  list(@Param('teamId') teamId: string) {
    return this.keys.listMeta(teamId);
  }

  @Delete(':provider')
  async remove(
    @Param('teamId') teamId: string,
    @Param('provider') provider: string,
  ) {
    await this.keys.delete(teamId, this.parseProvider(provider));
    return { ok: true };
  }
}
