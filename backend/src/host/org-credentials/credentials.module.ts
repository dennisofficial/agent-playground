import { CreateModule } from '@dltech/nestjs-core';
import {
  OrgCredential,
  OrgCredentialRepo,
} from '../../_lib/database/entities/org-credential.entity';
import { OrgModule } from '../org/org.module';
import { OrgCredentialsController } from './credentials.controller';
import { OrgCredentialsService } from './credentials.service';

@CreateModule({
  imports: [OrgModule], // OrgService for the membership/owner tenancy gate in the controller
  entities: [{ entity: OrgCredential, repoClass: OrgCredentialRepo }],
  services: [OrgCredentialsService], // exported — consumed directly by the GitHub module et al.
  controllers: [OrgCredentialsController],
})
export class OrgCredentialsModule {}
