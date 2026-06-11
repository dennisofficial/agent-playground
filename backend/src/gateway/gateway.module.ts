import { EnvService } from '@core/config/env/env.service';
import { envConfigValidation } from '@core/config/env/validation';
import { SecretCipher } from '@harness/projects/secret-cipher';
import { TypeOrmModule } from '@nestjs/typeorm';
import { CreateModule, EnvModule, LoggerModule } from '@workspace/nestjs-core';
import { Tenant } from '@workspace/shared/schemas';
import { ForwarderService } from './forwarder.service';
import { GatewayDatabaseModule } from './gateway-database.module';
import { ManualOrchestrator } from './orchestrator/manual-orchestrator';
import {
  STACK_ORCHESTRATOR,
  TENANT_PROVISIONER,
} from './orchestrator/stack-orchestrator.port';
import { TenantProvisionerService } from './orchestrator/tenant-provisioner.service';
import { SlackEventsController } from './slack-events.controller';
import { SlackInteractivityController } from './slack-interactivity.controller';
import { SlackOauthController } from './slack-oauth.controller';
import { SlackSignatureGuard } from './slack-signature.guard';
import { TenantStore } from './tenants/tenant.store';

/**
 * gateway = the multi-tenant Slack front door (see main.ts). Composes the CONTROL database only —
 * neither HarnessModule nor the tenant schema. STACK_ORCHESTRATOR is the deploy-pass seam: v1
 * binds ManualOrchestrator (overlay + DB + printed run command); the compose orchestrator
 * replaces that binding without touching the provisioning flow.
 */
@CreateModule({
  imports: [
    LoggerModule,
    EnvModule.forRoot({
      envService: EnvService,
      validationSchema: envConfigValidation,
    }),
    GatewayDatabaseModule,
    TypeOrmModule.forFeature([Tenant]),
  ],
  controllers: [
    SlackEventsController,
    SlackInteractivityController,
    SlackOauthController,
  ],
  providers: [
    SlackSignatureGuard,
    SecretCipher,
    TenantStore,
    ForwarderService,
    { provide: STACK_ORCHESTRATOR, useClass: ManualOrchestrator },
    { provide: TENANT_PROVISIONER, useClass: TenantProvisionerService },
  ],
})
export class GatewayModule {}
