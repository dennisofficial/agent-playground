import { Global } from '@nestjs/common';
import { CreateModule } from '@workspace/nestjs-core';
import { SecretCipherService } from './secret-cipher.service';

/**
 * Global crypto primitives. Provides the shared {@link SecretCipherService} (AES-256-GCM secrets-at-rest)
 * to every module — both the key-agnostic vault and the agent-credentials module encrypt through it, so
 * there's exactly one implementation and one key load. `@Global`, so consumers inject it without importing.
 */
@Global()
@CreateModule({
  services: [SecretCipherService], // auto-exported
})
export class CryptoModule {}
