import { Global, Module } from '@nestjs/common';
import { BrainGateway } from './brain-gateway.service';

@Global()
@Module({
  providers: [BrainGateway],
  exports: [BrainGateway],
})
export class BrainGatewayModule {}
