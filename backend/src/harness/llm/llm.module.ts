import { CreateModule } from '@workspace/nestjs-core';
import { CredentialModule } from '../llm-keys/credential.module';
import { ChatModelFactory } from './chat-model.factory';

/**
 * Model builders for the chat layer (chat / gate / extract). Consolidated here — one provider,
 * env-driven — because the gate, the bot graph, and the reconcile passes all draw from it.
 * Imports the @Global CredentialModule it depends on (ChatModelFactory reads the per-turn tenant
 * key from CredentialContext), so LlmModule resolves standalone — not only under the full harness.
 */
@CreateModule({
  imports: [CredentialModule],
  services: [ChatModelFactory],
})
export class LlmModule {}
