import { EnvService } from '@core/config/env/env.service';
import { PROPOSAL_PRESENTER } from '@harness/approvals/proposal-presenter.port';
import { ChannelModule } from '@harness/channel/channel.module';
import { ConductorModule } from '@harness/conductor/conductor.module';
import { EmployeesModule } from '@harness/employees/employees.module';
import { LlmKeysModule } from '@harness/llm-keys/llm-keys.module';
import { MemoryModule } from '@harness/memory/memory.module';
import { ProjectsModule } from '@harness/projects/projects.module';
import { SecretCipher } from '@harness/projects/secret-cipher';
import { SlackIdentitiesModule } from '@harness/slack-identities/slack-identities.module';
import { ARTIFACT_SINK } from '@harness/surface/artifact-sink.port';
import { CHAT_SURFACE } from '@harness/surface/chat-surface.port';
import { Global, Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { SocketModeClient } from '@slack/socket-mode';
import { Tenant } from '@workspace/shared/schemas';
import { ApprovalCardsService } from './approvals/approval-cards.service';
import { JarvisService } from './jarvis/jarvis.service';
import { LeadPresenceService } from './lead-presence.service';
import { SlackChatSurface } from './slack-chat-surface';
import { SlackDirectoryService } from './slack-directory.service';
import { SlackFileUploadService } from './slack-file-upload.service';
import { SlackIdentityRegistry } from './slack-identity.registry';
import { SlackInboundRouter } from './slack-inbound.router';
import {
  APPROVAL_INTERCEPTOR,
  JARVIS_INTERCEPTOR,
} from './slack-inbound.types';
import { SlackSocketTransport } from './slack-socket-transport';
import { SLACK_SOCKET_MODE_CLIENT } from './slack.tokens';
import { TenantStore } from './tenant.store';
import { TenantSlackClients } from './tenant-slack-clients';

/**
 * Binds the Slack adapter to the harness's CHAT_SURFACE token — the Slack twin of
 * TuiSurfaceModule, @Global for the same reason (the harness's SurfaceBridge optionally injects
 * the token from ITS module scope; a global export is how the hosting app's binding reaches it).
 * The SDK clients are factory providers off EnvService; main.ts asserts the tokens exist before
 * the Nest context is even created, so the factories never see undefined in practice.
 */
@Global()
@Module({
  imports: [
    ConductorModule,
    ChannelModule,
    EmployeesModule,
    LlmKeysModule,
    MemoryModule,
    ProjectsModule,
    SlackIdentitiesModule,
    TypeOrmModule.forFeature([Tenant]),
  ],
  providers: [
    SecretCipher,
    TenantStore,
    TenantSlackClients,
    {
      // Socket Mode client only in dev (SLACK_APP_TOKEN set); prod (Events API) has no socket —
      // the transport provider is @Optional about it and main.ts never calls connect() there.
      provide: SLACK_SOCKET_MODE_CLIENT,
      useFactory: (env: EnvService) => {
        // Socket Mode only in dev (SLACK_APP_TOKEN set). In prod (Events API ingress) there is no
        // socket — the transport is @Optional about it and main.ts never calls connect().
        const appToken = env.get('SLACK_APP_TOKEN');
        return appToken ? new SocketModeClient({ appToken }) : undefined;
      },
      inject: [EnvService],
    },
    SlackDirectoryService,
    SlackIdentityRegistry,
    LeadPresenceService,
    SlackChatSurface,
    SlackFileUploadService,
    SlackInboundRouter,
    SlackSocketTransport,
    JarvisService,
    ApprovalCardsService,
    { provide: JARVIS_INTERCEPTOR, useExisting: JarvisService },
    { provide: APPROVAL_INTERCEPTOR, useExisting: ApprovalCardsService },
    // The plan-proposal OUTBOUND PORT's Slack adapter (propose_plan → approval card) — bound here
    // exactly like CHAT_SURFACE; headless/TUI hosts bind nothing and get the chat-words fallback.
    { provide: PROPOSAL_PRESENTER, useExisting: ApprovalCardsService },
    { provide: CHAT_SURFACE, useExisting: SlackChatSurface },
    // The artifact-upload port's Slack adapter (share_artifact → filesUploadV2 + chat.update).
    { provide: ARTIFACT_SINK, useExisting: SlackFileUploadService },
  ],
  exports: [
    CHAT_SURFACE,
    ARTIFACT_SINK,
    // A @Global module shares ONLY what it exports — without this line the harness's
    // propose_plan resolves no presenter and degrades to chat-words. (APPROVAL_INTERCEPTOR
    // needs no export: its consumer, SlackInboundRouter, lives in this module.)
    PROPOSAL_PRESENTER,
    SlackChatSurface,
    SlackInboundRouter,
    SlackSocketTransport,
  ],
})
export class SlackSurfaceModule {}
