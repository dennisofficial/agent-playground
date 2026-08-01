import { CreateModule } from '@dltech/nestjs-core';
import {
  InboundMessage,
  InboundMessageRepo,
} from '../../_lib/database/entities/inbound-message.entity';
import { InboundMessageService } from './inbound-message.service';

@CreateModule({
  entities: [{ entity: InboundMessage, repoClass: InboundMessageRepo }],
  services: [InboundMessageService],
})
export class InboundMessageModule {}
