import { getRepositoryToken, TypeOrmModule } from '@nestjs/typeorm';
import { CreateModule } from '@workspace/nestjs-core';
import { PgRealtimeModule } from '@workspace/pg-realtime/nest';
import type { Repository } from 'typeorm';
import {
  AgentCredential,
  AgentCredentialRepo,
} from '../../_lib/database/entities/agent-credential.entity';
import { OrganizationMember } from '../../_lib/database/entities/organization-member.entity';
import { OrgModule } from '../org/org.module';
import { AgentAuthRefreshSink } from './agent-auth-refresh.sink';
import { AgentCredentialKeepaliveService } from './agent-credential-keepalive.service';
import { AgentCredentialRefreshService } from './agent-credential-refresh.service';
import { AgentCredentialResolver } from './agent-credential-resolver.service';
import { AgentCredentialService } from './agent-credential.service';
import { AgentCredentialsController } from './agent-credentials.controller';
import { buildAgentCredentialsRealtimeModel } from './agent-credentials.realtime';
import { OAuthDeviceStore } from './oauth/oauth-device.store';
import { OAuthPkceStore } from './oauth/oauth-pkce.store';
import { AgentUsageService } from './usage/agent-usage.service';

/**
 * Agent SDK credential manager — multi-account Claude/Codex subscription login + per-account usage. Owns
 * the OAuth flows (Claude paste-the-code, Codex device-code), refresh/keepalive, and the `agentCredentials`
 * realtime feed. Exports the two engine-facing concrete services directly — {@link AgentCredentialResolver}
 * (resolve runtime auth) and {@link AgentAuthRefreshSink} (persist a mid-run token rotation); the engine
 * injects them later. SecretCipherService comes from the global CryptoModule; Redis from the global RedisModule.
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
  // exported — the two engine-facing seams are the concrete resolver + refresh sink.
  services: [AgentCredentialService, AgentCredentialResolver, AgentAuthRefreshSink],
  providers: [
    AgentCredentialRefreshService,
    AgentCredentialKeepaliveService,
    AgentUsageService,
    OAuthPkceStore,
    OAuthDeviceStore,
  ],
  controllers: [AgentCredentialsController],
})
export class AgentCredentialsModule {}
