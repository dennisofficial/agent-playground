import { Global, Module } from '@nestjs/common';
import { CredentialContext } from './credential-context';

/**
 * The per-turn tenant-key context (CredentialContext), provided @Global so the model/embedding
 * builders and the conductor share ONE AsyncLocalStorage instance without import wiring — the same
 * cross-cutting-singleton pattern as DatabaseModule/EsmModule. Imported once by HarnessModule.
 */
@Global()
@Module({
  providers: [CredentialContext],
  exports: [CredentialContext],
})
export class CredentialModule {}
