import { Global, Module } from '@nestjs/common';
import { DriverApprovalGateway } from './driver-approval-gateway.service';

@Global()
@Module({
  providers: [DriverApprovalGateway],
  exports: [DriverApprovalGateway],
})
export class DriverApprovalGatewayModule {}
