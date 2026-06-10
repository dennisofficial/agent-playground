import { CreateModule } from '@workspace/nestjs-core';
import { ConductorEventsBus } from './conductor-events.bus';

/**
 * The events bus in its own module so non-conductor providers can emit presentation events without
 * importing the whole ConductorModule (which imports ToolsModule — a tool needing the bus would
 * otherwise be a cycle). The bus stays the single seam surfaces subscribe to.
 */
@CreateModule({
  services: [ConductorEventsBus],
})
export class ConductorEventsModule {}
