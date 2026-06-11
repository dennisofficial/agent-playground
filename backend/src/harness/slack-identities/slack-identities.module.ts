import { getRepositoryToken, TypeOrmModule } from '@nestjs/typeorm';
import { CreateModule } from '@workspace/nestjs-core';
import { SlackIdentity } from '@workspace/shared/schemas';
import { Repository } from 'typeorm';
import { SecretCipher } from '../projects/secret-cipher';
import { SlackIdentityStore } from './slack-identity.store';

/**
 * Per-employee Slack puppet tokens — a SLIM module (the llm-keys pattern) composable by BOTH the
 * slack-app (the identity registry resolves clients) and the api app (admin REST writes tokens),
 * with zero imports from the rest of the harness. Requires the hosting app's @Global
 * DatabaseModule + EnvModule. SecretCipher is stateless — re-provided here to stay decoupled.
 */
@CreateModule({
  imports: [TypeOrmModule.forFeature([SlackIdentity])],
  services: [
    SecretCipher,
    {
      provide: SlackIdentityStore,
      inject: [getRepositoryToken(SlackIdentity), SecretCipher],
      useFactory: (repo: Repository<SlackIdentity>, cipher: SecretCipher) =>
        new SlackIdentityStore(repo, cipher),
    },
  ],
})
export class SlackIdentitiesModule {}
