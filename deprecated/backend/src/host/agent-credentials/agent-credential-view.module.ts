import { CreateModule } from '@dltech/nestjs-core';
import { AgentCredentialViewService } from './agent-credential-view.service';

@CreateModule({
  services: [AgentCredentialViewService],
})
export class AgentCredentialViewModule {}
