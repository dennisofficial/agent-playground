import { Global, Module } from '@nestjs/common';
import { BrainGateway } from './brain-gateway.service';

/**
 * The NEUTRAL driver↔brain seam module. Depends on NOTHING, and is @Global so both the @Global
 * `BrainModule` (which binds itself into the gateway) and the @Global `DriverModule` (which consumes it)
 * can inject `BrainGateway` without either importing the other — breaking the DI construction cycle that a
 * direct driver→brain dependency would form. See {@link BrainGateway}.
 */
@Global()
@Module({
  providers: [BrainGateway],
  exports: [BrainGateway],
})
export class BrainGatewayModule {}
