import { CreateModule } from '@workspace/nestjs-core';
import {
  DevConsoleController,
  DevConsoleGuard,
} from './dev-console.controller';
import { DevConsoleService } from './dev-console.service';

/**
 * DEV-ONLY. Imported by `SlackAppModule` only when `DEV_CONSOLE_ENABLED` is set, so it (and its HTTP
 * controller) never exist in prod. Lets a terminal CLI drive + observe Atlas on a dedicated `console:*`
 * thread, against the running harness (the providers it injects — ConductorService, ConductorEventsBus,
 * ChannelService, ChannelRegistryService, EmployeeRegistry, SESSION_REGISTRY — are all re-exported by
 * the composed `HarnessModule`).
 */
@CreateModule({
  controllers: [DevConsoleController],
  services: [DevConsoleService, DevConsoleGuard],
})
export class DevConsoleModule {}
