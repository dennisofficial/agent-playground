import { z } from 'zod';
import { EmployeeRegistry } from '../../employees/employee.registry';
import { CredentialRotationBus } from '../../llm-keys/credential-rotation.bus';
import { ProviderKeyStore } from '../../llm-keys/provider-key.store';
import { TenantCredentialService } from '../../llm-keys/tenant-credential.service';
import { HarnessTool } from '../harness-tool.decorator';
import type { HarnessToolContext, IHarnessTool } from '../tool.types';

const fallBackSchema = z.object({
  provider: z
    .enum(['anthropic', 'openai'])
    .describe(
      "Which provider to switch back to metered API-key billing: 'anthropic' (Claude) or 'openai' (Codex/ChatGPT).",
    ),
});

const LABEL: Record<'anthropic' | 'openai', string> = {
  anthropic: 'Claude (Anthropic)',
  openai: 'Codex (OpenAI)',
};

/**
 * Switch a provider's ENGINE turns from its workspace SUBSCRIPTION back to the metered API key —
 * the no-secret fallback when a subscription token has failed and Dennis has said to fall back. It
 * only flips `engine_auth_mode` to 'api_key' (keeping the stored subscription secret for later), and
 * it's always safe because the API key is always present. Lead-only.
 *
 * IMPORTANT: never call this on your own — only AFTER Dennis explicitly confirms he wants to fall back
 * (a subscription failure is HIS call). It's loud (you announce it) and reversible (rotate_keys can
 * re-enable the subscription anytime).
 */
@HarnessTool()
export class FallBackToApiKeyTool implements IHarnessTool<typeof fallBackSchema> {
  readonly name = 'fall_back_to_api_key';
  readonly description =
    "Switch a provider's coding-engine turns from its Claude/ChatGPT SUBSCRIPTION back to the metered API key (no secret needed — the API key is always there; the subscription token is kept for later). Use ONLY after Dennis confirms he wants to fall back following a subscription auth failure — never decide it yourself. Lead-only, reversible via rotate_keys.";
  readonly schema = fallBackSchema;

  constructor(
    private readonly employees: EmployeeRegistry,
    private readonly keyStore: ProviderKeyStore,
    private readonly creds: TenantCredentialService,
    private readonly rotation: CredentialRotationBus,
  ) {}

  async execute(
    { provider }: z.infer<typeof fallBackSchema>,
    ctx: HarnessToolContext,
  ): Promise<string> {
    const id = ctx.identity;
    if (!this.employees.byId(id.selfAgent)?.teamLead)
      return `Switching billing is the team lead's call.`;

    // The fallback is only safe if there's an API key to fall back TO (store or env). Guard it.
    const apiKey = (await this.creds.resolve(id.team))[provider];
    if (!apiKey)
      return `Can't fall back — there's no ${LABEL[provider]} API key stored to bill against. Have Dennis add one first via rotate_keys, then fall back.`;

    try {
      await this.keyStore.putSubscription(id.team, provider, 'api_key');
    } catch (err) {
      return `Couldn't switch ${LABEL[provider]} to API-key billing (${err instanceof Error ? err.message : String(err)}).`;
    }
    // Fan the change out so the next engine turn re-resolves to api_key mode immediately.
    this.rotation.emit(id.team);

    return `✅ Switched ${LABEL[provider]} engine turns to the metered API key (the subscription token is kept — rotate_keys can re-enable it). Tell Dennis it's done in your own voice, and retry whatever was blocked.`;
  }
}
