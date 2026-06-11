import { getRepositoryToken, TypeOrmModule } from '@nestjs/typeorm';
import { CreateModule } from '@workspace/nestjs-core';
import { ProviderKey } from '@workspace/shared/schemas';
import { Repository } from 'typeorm';
import { SecretCipher } from '../projects/secret-cipher';
import { LlmReadinessService } from './llm-readiness.service';
import { ProviderKeyStore } from './provider-key.store';
import { TenantCredentialService } from './tenant-credential.service';

/**
 * Tenant LLM keys + pending-keys readiness — a SLIM module (the ProjectsModule pattern) composable
 * by BOTH the harness (conductor gates scheduling on readiness) and the api app (admin REST writes
 * keys), with zero imports from the rest of the harness. Requires the hosting app's @Global
 * DatabaseModule + EnvModule. SecretCipher is stateless — re-providing it here keeps the module
 * decoupled from ProjectsModule (double-import is harmless either way).
 */
@CreateModule({
  imports: [TypeOrmModule.forFeature([ProviderKey])],
  services: [
    SecretCipher,
    {
      provide: ProviderKeyStore,
      inject: [getRepositoryToken(ProviderKey), SecretCipher],
      useFactory: (keys: Repository<ProviderKey>, cipher: SecretCipher) =>
        new ProviderKeyStore(keys, cipher),
    },
    TenantCredentialService,
    LlmReadinessService,
  ],
})
export class LlmKeysModule {}
