import { CreateModule } from '@workspace/nestjs-core';
import { HostTransportModule } from '../host-transport/host-transport.module';
import { SandboxModule } from '../sandbox/sandbox.module';
import { TurnDispatcherService } from './turn-dispatcher.service';

/**
 * The turn-execution seam: mints a turn, hands the spec to the transport, and drives the sandbox runtime.
 * Composes the dumb Redis messenger ({@link HostTransportModule}) with the runtime ({@link SandboxModule}).
 */
@CreateModule({
  imports: [HostTransportModule, SandboxModule],
  services: [TurnDispatcherService],
})
export class TurnModule {}
