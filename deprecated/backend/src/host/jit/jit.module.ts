import { DiscoveryModule } from '@nestjs/core';
import { CreateModule } from '@dltech/nestjs-core';
import { JitHostRegistry } from './jit.registry';

@CreateModule({
  imports: [DiscoveryModule],
  services: [JitHostRegistry],
})
export class JitHostModule {}
