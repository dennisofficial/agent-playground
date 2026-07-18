import { getRepositoryToken, TypeOrmModule } from '@nestjs/typeorm';
import { CreateModule } from '@workspace/nestjs-core';
import { PgRealtimeModule } from '@workspace/pg-realtime/nest';
import type { Repository } from 'typeorm';
import { OrganizationMember } from '../org/entities/organization-member.entity';
import { OrgModule } from '../org/org.module';
import { AgentAuthRefreshSink } from './agent-auth-refresh.sink';
import { AgentCredentialKeepaliveService } from './agent-credential-keepalive.service';
import { AgentCredentialRefreshService } from './agent-credential-refresh.service';
import { AgentCredentialResolver } from './agent-credential-resolver.service';
import { AgentCredentialService } from './agent-credential.service';
import { AgentCredentialsController } from './agent-credentials.controller';
import { buildAgentCredentialsRealtimeModel } from './agent-credentials.realtime';
import { AgentCredential, AgentCredentialRepo } from './entities/agent-credential.entity';
import { OAuthDeviceStore } from './oauth/oauth-device.store';
import { OAuthPkceStore } from './oauth/oauth-pkce.store';
import { AGENT_AUTH_PORT } from './ports/agent-auth.port';
import { AUTH_REFRESH_SINK } from './ports/auth-refresh-sink.port';
import { AgentUsageService } from './usage/agent-usage.service';

/**
 * Agent SDK credential manager — multi-account Claude/Codex subscription login + per-account usage. Owns
 * the OAuth flows (Claude paste-the-code, Codex device-code), refresh/keepalive, and the `agentCredentials`
 * realtime feed. Exposes two engine seams as tokens: {@link AGENT_AUTH_PORT} (resolve runtime auth) and
 * {@link AUTH_REFRESH_SINK} (persist a mid-run token rotation) — the engine will inject these later.
 * SecretCipherService comes from the global CryptoModule; Redis from the global RedisModule.
 */
@CreateModule({
  imports: [
    OrgModule, // OrgService tenancy gate in the controller
    PgRealtimeModule.forFeature({
      imports: [TypeOrmModule.forFeature([OrganizationMember])],
      inject: [getRepositoryToken(OrganizationMember)],
      useFactory: (members: Repository<OrganizationMember>) => [
        buildAgentCredentialsRealtimeModel(members),
      ],
    }),
  ],
  entities: [{ entity: AgentCredential, repoClass: AgentCredentialRepo }],
  services: [AgentCredentialService, AgentCredentialResolver], // exported
  providers: [
    AgentCredentialRefreshService,
    AgentCredentialKeepaliveService,
    AgentUsageService,
    OAuthPkceStore,
    OAuthDeviceStore,
    AgentAuthRefreshSink,
    { provide: AGENT_AUTH_PORT, useExisting: AgentCredentialResolver },
    { provide: AUTH_REFRESH_SINK, useExisting: AgentAuthRefreshSink },
  ],
  controllers: [AgentCredentialsController],
  exports: [AGENT_AUTH_PORT, AUTH_REFRESH_SINK],
})
export class AgentCredentialsModule {}
