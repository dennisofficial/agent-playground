import { EnvService } from '@core/config/env/env.service';
import { Global, Module } from '@nestjs/common';
import { CredentialResolver } from '../onboarding/credential-resolver.service';
import {
  AnthropicInstallAwarenessFilter,
  INSTALL_AWARENESS_FILTER,
} from './install-awareness-filter';
import { ProfileAwarenessService } from './profile-awareness.service';
import { WorkspaceProfileService } from './workspace-profile.service';

export const INSTALL_AWARENESS_FILTER_DISABLED = 'INSTALL_AWARENESS_FILTER_DISABLED';

@Global()
@Module({
  providers: [
    WorkspaceProfileService,
    ProfileAwarenessService,
    {
      provide: INSTALL_AWARENESS_FILTER,
      inject: [CredentialResolver, EnvService],
      useFactory: (creds: CredentialResolver, env: EnvService) =>
        env.get(INSTALL_AWARENESS_FILTER_DISABLED) !== 'on'
          ? new AnthropicInstallAwarenessFilter((orgId) => creds.anthropicKey(orgId))
          : undefined,
    },
  ],
  exports: [WorkspaceProfileService, ProfileAwarenessService, INSTALL_AWARENESS_FILTER],
})
export class WorkspaceProfileModule {}
