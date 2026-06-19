import { Global, Module } from '@nestjs/common';
import { CredentialContext } from './credential-context';
import { CredentialRotationBus } from './credential-rotation.bus';

/**
 * The per-turn tenant-key context (CredentialContext) + the credential-rotation bus
 * (CredentialRotationBus), provided @Global so the model/embedding builders, the conductor, and
 * every credential-keyed cache share ONE instance without import wiring — the same
 * cross-cutting-singleton pattern as DatabaseModule/EsmModule. Imported once by HarnessModule.
 */
@Global()
@Module({
  providers: [CredentialContext, CredentialRotationBus],
  exports: [CredentialContext, CredentialRotationBus],
})
export class CredentialModule {}
