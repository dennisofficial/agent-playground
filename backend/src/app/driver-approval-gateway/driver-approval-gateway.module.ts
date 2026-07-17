import { Global, Module } from '@nestjs/common';
import { DriverApprovalGateway } from './driver-approval-gateway.service';

/**
 * The NEUTRAL surface↔driver approval seam module. Depends on NOTHING, and is @Global so both the @Global
 * `DriverModule` (which binds the concrete driver adapter into the gateway) and the surface
 * (`WebSurfaceModule` / `WebSurfaceController`, which consume it) can inject `DriverApprovalGateway` without
 * the surface importing the driver — breaking the module cycle a direct surface→driver dependency would form
 * (`DriverModule` already depends on the surface for `CHAT_SURFACE`). Mirrors `BrainGatewayModule`. See
 * {@link DriverApprovalGateway}.
 */
@Global()
@Module({
  providers: [DriverApprovalGateway],
  exports: [DriverApprovalGateway],
})
export class DriverApprovalGatewayModule {}
