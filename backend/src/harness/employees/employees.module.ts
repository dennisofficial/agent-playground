import { DiscoveryModule } from '@nestjs/core';
import { CreateModule } from '@workspace/nestjs-core';
import { EmployeeRegistry } from './employee.registry';
import { PersonaService } from './persona.service';
import { AtlasEmployee } from './roster/atlas.employee';
import { PhaseBackendConfig } from './phase-configs/phase-backend.config';
import { PhaseFrontendConfig } from './phase-configs/phase-frontend.config';
import { PhaseDesignConfig } from './phase-configs/phase-design.config';
import { PhaseResearchConfig } from './phase-configs/phase-research.config';
import { PhaseMarketingConfig } from './phase-configs/phase-marketing.config';
import { PhaseAnalyticsConfig } from './phase-configs/phase-analytics.config';

/**
 * The team. Atlas — the orchestrator — is the only `@AIEmployee()` chat-roster member; it's registered
 * here as a PLAIN CLASS provider (discovery cannot see factory providers) and `EmployeeRegistry`
 * assembles + validates the roster at boot.
 *
 * The work itself runs as pipeline SECTIONS, each as a `@PhaseConfig()` role identity (backend,
 * frontend, design, research, marketing, analytics). Phase-configs are registered the same way but
 * discovered into a SEPARATE list — resolvable + provisioned, but never on the chat roster. Adding a
 * section role = one new class in `phase-configs/` + one line below.
 */
@CreateModule({
  imports: [DiscoveryModule],
  services: [EmployeeRegistry, PersonaService],
  providers: [
    AtlasEmployee,
    // Pipeline phase-configs (synthetic worker identities — NOT chat roster).
    PhaseBackendConfig,
    PhaseFrontendConfig,
    PhaseDesignConfig,
    PhaseResearchConfig,
    PhaseMarketingConfig,
    PhaseAnalyticsConfig,
  ],
})
export class EmployeesModule {}
