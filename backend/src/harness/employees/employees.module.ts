import { DiscoveryModule } from '@nestjs/core';
import { CreateModule } from '@workspace/nestjs-core';
import { EmployeeRegistry } from './employee.registry';
import { PersonaService } from './persona.service';
import { AlexEmployee } from './roster/alex.employee';
import { JamesEmployee } from './roster/james.employee';
import { MayaEmployee } from './roster/maya.employee';
import { NoraEmployee } from './roster/nora.employee';
import { RileyEmployee } from './roster/riley.employee';
import { SamEmployee } from './roster/sam.employee';

/**
 * The team. Every `@AIEmployee()` roster class is registered here as a PLAIN CLASS provider
 * (discovery cannot see factory providers); `EmployeeRegistry` assembles + validates the roster at
 * boot. Adding a teammate = one new class in `roster/` + one line below.
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
    SamEmployee,
  ],
})
export class EmployeesModule {}
