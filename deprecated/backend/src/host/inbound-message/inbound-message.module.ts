import { CreateModule } from '@dltech/nestjs-core';
import { InboundMessageService } from './inbound-message.service';

@CreateModule({
  services: [InboundMessageService],
})
export class InboundMessageModule {}
