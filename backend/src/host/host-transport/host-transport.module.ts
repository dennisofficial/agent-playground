import { CreateModule } from '@dltech/nestjs-core';
import { HostTransportService } from './host-transport.service';

@CreateModule({
  services: [HostTransportService],
})
export class HostTransportModule {}
