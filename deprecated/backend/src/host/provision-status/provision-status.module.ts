import { CreateModule } from '@dltech/nestjs-core';
import { ProvisionStatusService } from './provision-status.service';

@CreateModule({
  services: [ProvisionStatusService],
})
export class ProvisionStatusModule {}
