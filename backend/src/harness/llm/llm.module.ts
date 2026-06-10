import { CreateModule } from '@workspace/nestjs-core';
import { ChatModelFactory } from './chat-model.factory';

/**
 * Model builders for the chat layer (chat / gate / extract). Consolidated here — one provider,
 * env-driven — because the gate, the bot graph, and the reconcile passes all draw from it.
 */
@CreateModule({
  services: [ChatModelFactory],
})
export class LlmModule {}
