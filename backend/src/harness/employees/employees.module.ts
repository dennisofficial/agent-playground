import { DiscoveryModule } from '@nestjs/core';
import { CreateModule } from '@workspace/nestjs-core';
import { EmployeeRegistry } from './employee.registry';
import { PersonaService } from './persona.service';
import { AlexEmployee } from './roster/alex.employee';
import { JamesEmployee } from './roster/james.employee';
import { MayaEmployee } from './roster/maya.employee';
import { NoraEmployee } from './roster/nora.employee';
import { RileyEmployee } from './roster/riley.employee';
import { AtlasEmployee } from './roster/atlas.employee';
import { PhaseBackendConfig } from './phase-configs/phase-backend.config';
import { PhaseFrontendConfig } from './phase-configs/phase-frontend.config';

/**
 * The team. Every `@AIEmployee()` roster class is registered here as a PLAIN CLASS provider
 * (discovery cannot see factory providers); `EmployeeRegistry` assembles + validates the roster at
 * boot. Adding a teammate = one new class in `roster/` + one line below.
 *
 * `@PhaseConfig()` classes (pipeline phase-configs) are registered the same way but discovered into a
 * SEPARATE list — resolvable + provisioned, but never on the chat roster.
 */
@CreateModule({
  imports: [DiscoveryModule],
  services: [EmployeeRegistry, PersonaService],
  providers: [
    AlexEmployee,
    RileyEmployee,
    MayaEmployee,
    JamesEmployee,
    NoraEmployee,
    AtlasEmployee,
    // Pipeline phase-configs (synthetic worker identities — NOT chat roster).
    PhaseBackendConfig,
    PhaseFrontendConfig,
  ],
})
export class EmployeesModule {}
