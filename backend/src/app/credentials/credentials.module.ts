import { CreateModule } from '@workspace/nestjs-core';
import { OrgModule } from '../org/org.module';
import { CredentialsController } from './credentials.controller';
import { CredentialsService } from './credentials.service';
import { OrgSecret, OrgSecretRepo } from './entities/org-secret.entity';

@CreateModule({
  imports: [OrgModule], // OrgService for the membership/owner tenancy gate in the controller
  entities: [{ entity: OrgSecret, repoClass: OrgSecretRepo }],
  services: [CredentialsService], // exported — consumed directly by the GitHub module et al.
  controllers: [CredentialsController],
})
export class CredentialsModule {}
