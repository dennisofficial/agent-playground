import { DiscoveryModule } from '@nestjs/core';
import { CreateModule } from '@workspace/nestjs-core';
import { JitHostRegistry } from './jit.registry';

@CreateModule({
  imports: [DiscoveryModule],
  services: [JitHostRegistry],
})
export class JitHostModule {}
