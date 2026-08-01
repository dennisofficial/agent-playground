import { CreateModule } from '@dltech/nestjs-core';
import { EngineTransportService } from './engine-transport.service';

@CreateModule({
  services: [EngineTransportService], // exported
})
export class EngineTransportModule {}
