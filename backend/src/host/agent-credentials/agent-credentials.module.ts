import { CreateModule } from '@workspace/nestjs-core';
import { RLS_CONTEXT, type RlsContextConfig } from '@workspace/nestjs-rls/nest';
import { PgRealtimeModule } from '@workspace/pg-realtime/nest';
import {
  AgentCredential,
  AgentCredentialRepo,
} from '../../_lib/database/entities/agent-credential.entity';
import { OrgModule } from '../org/org.module';
import { AgentAuthEnvProvider } from './agent-auth-env.provider';
import { AgentAuthRefreshSink } from './agent-auth-refresh.sink';
import { AgentCredentialKeepaliveService } from './agent-credential-keepalive.service';
import { AgentCredentialRefreshService } from './agent-credential-refresh.service';
import { AgentCredentialResolver } from './agent-credential-resolver.service';
import { AgentCredentialViewService } from './agent-credential-view.service';
import { AgentCredentialService } from './agent-credential.service';
import { AgentCredentialsController } from './agent-credentials.controller';
import { buildAgentCredentialsRealtimeModel } from './agent-credentials.realtime';
import { ClaudeOAuthClient } from './oauth/claude-oauth.client';
import { CodexOAuthClient } from './oauth/codex-oauth.client';
import { OAuthDeviceStore } from './oauth/oauth-device.store';
import { OAuthPkceStore } from './oauth/oauth-pkce.store';
import { AgentUsageService } from './usage/agent-usage.service';

@CreateModule({
  imports: [
    OrgModule,
    PgRealtimeModule.forFeature({
      inject: [RLS_CONTEXT, AgentCredentialViewService],
      useFactory: (ctx: RlsContextConfig, view: AgentCredentialViewService) => [
        buildAgentCredentialsRealtimeModel(ctx.resolveClaims, view),
      ],
    }),
  ],
  entities: [{ entity: AgentCredential, repoClass: AgentCredentialRepo }],
  services: [
    AgentCredentialService,
    AgentCredentialResolver,
    AgentAuthRefreshSink,
    AgentAuthEnvProvider,
  ],
  providers: [
    AgentCredentialViewService,
    AgentCredentialRefreshService,
    AgentCredentialKeepaliveService,
    AgentUsageService,
    ClaudeOAuthClient,
    CodexOAuthClient,
    OAuthPkceStore,
    OAuthDeviceStore,
  ],
  controllers: [AgentCredentialsController],
})
export class AgentCredentialsModule {}
