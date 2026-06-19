import { EnvService } from '@core/config/env/env.service';
import { BOARD_NOTIFIER } from '@harness/approvals/board-notifier.port';
import { PROJECT_ONBOARD_PRESENTER } from '@harness/approvals/project-onboard-presenter.port';
import { ProjectOnboardModule } from '@harness/approvals/project-onboard.module';
import { ROTATE_KEYS_PRESENTER } from '@harness/llm-keys/rotate-keys-presenter.port';
import { PROPOSAL_PRESENTER } from '@harness/approvals/proposal-presenter.port';
import { TASK_SUGGESTION_PRESENTER } from '@harness/approvals/task-suggestion-presenter.port';
import { ChannelModule } from '@harness/channel/channel.module';
import { ConductorModule } from '@harness/conductor/conductor.module';
import { EmployeesModule } from '@harness/employees/employees.module';
import { LlmKeysModule } from '@harness/llm-keys/llm-keys.module';
import { MemoryModule } from '@harness/memory/memory.module';
import { ProjectsModule } from '@harness/projects/projects.module';
import { SecretCipher } from '@harness/projects/secret-cipher';
import { ARTIFACT_SINK } from '@harness/surface/artifact-sink.port';
import { CHAT_SURFACE } from '@harness/surface/chat-surface.port';
import { Global, Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { SocketModeClient } from '@slack/socket-mode';
import { Tenant } from '@workspace/shared/schemas';
import { ApprovalCardsService } from './approvals/approval-cards.service';
import { SuggestionCardsService } from './approvals/suggestion-cards.service';
import { OnboardingGuardService } from './onboarding/onboarding-guard.service';
import { ProjectOnboardCardsService } from './onboarding/project-onboard-cards.service';
import { RotateKeysCardsService } from './onboarding/rotate-keys-cards.service';
import { SlackChatSurface } from './slack-chat-surface';
import { SlackCommandService } from './slack-commands.service';
import { SlackDirectoryService } from './slack-directory.service';
import { SlackFileUploadService } from './slack-file-upload.service';
import { SlackInboundRouter } from './slack-inbound.router';
import {
  APPROVAL_INTERCEPTOR,
  COMMAND_INTERCEPTOR,
  ONBOARDING_GUARD_INTERCEPTOR,
  PROJECT_ONBOARD_INTERCEPTOR,
  ROTATE_KEYS_INTERCEPTOR,
  SUGGESTION_INTERCEPTOR,
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
    ProjectOnboardModule,
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
    SlackChatSurface,
    SlackFileUploadService,
    SlackInboundRouter,
    SlackSocketTransport,
    OnboardingGuardService,
    ApprovalCardsService,
    SuggestionCardsService,
    ProjectOnboardCardsService,
    RotateKeysCardsService,
    SlackCommandService,
    {
      provide: ONBOARDING_GUARD_INTERCEPTOR,
      useExisting: OnboardingGuardService,
    },
    { provide: APPROVAL_INTERCEPTOR, useExisting: ApprovalCardsService },
    { provide: SUGGESTION_INTERCEPTOR, useExisting: SuggestionCardsService },
    {
      provide: PROJECT_ONBOARD_INTERCEPTOR,
      useExisting: ProjectOnboardCardsService,
    },
    { provide: COMMAND_INTERCEPTOR, useExisting: SlackCommandService },
    // The plan-proposal OUTBOUND PORT's Slack adapter (propose_plan → approval card) — bound here
    // exactly like CHAT_SURFACE; headless/TUI hosts bind nothing and get the chat-words fallback.
    { provide: PROPOSAL_PRESENTER, useExisting: ApprovalCardsService },
    // The task-suggestion OUTBOUND PORT's Slack adapter (suggest_task → clickable chip) — same idiom.
    { provide: TASK_SUGGESTION_PRESENTER, useExisting: SuggestionCardsService },
    // The project-onboarding OUTBOUND PORT's Slack adapter (onboard_project → card → modal) — same idiom.
    {
      provide: PROJECT_ONBOARD_PRESENTER,
      useExisting: ProjectOnboardCardsService,
    },
    // The credential-rotation card/modal slot + OUTBOUND PORT's Slack adapter (rotate_keys / the
    // system credential-health guard → update-keys card → modal) — same idiom.
    {
      provide: ROTATE_KEYS_INTERCEPTOR,
      useExisting: RotateKeysCardsService,
    },
    { provide: ROTATE_KEYS_PRESENTER, useExisting: RotateKeysCardsService },
    { provide: CHAT_SURFACE, useExisting: SlackChatSurface },
    // The artifact-upload port's Slack adapter (share_artifact → filesUploadV2 + chat.update).
    { provide: ARTIFACT_SINK, useExisting: SlackFileUploadService },
    // The description-change notification OUTBOUND PORT's Slack adapter (update_board_task with a
    // description edit on an approved-or-beyond ticket → inline channel card with @Dennis mention).
    { provide: BOARD_NOTIFIER, useExisting: ApprovalCardsService },
  ],
  exports: [
    CHAT_SURFACE,
    ARTIFACT_SINK,
    // A @Global module shares ONLY what it exports — without this line the harness's
    // propose_plan resolves no presenter and degrades to chat-words. (APPROVAL_INTERCEPTOR
    // needs no export: its consumer, SlackInboundRouter, lives in this module.)
    PROPOSAL_PRESENTER,
    // Same as PROPOSAL_PRESENTER — exported so the harness's suggest_task (SuggestionService,
    // registered in ToolsModule) resolves the chip adapter; without it suggestions degrade to chat-words.
    TASK_SUGGESTION_PRESENTER,
    // Exported so the harness's onboard_project (ProjectOnboardService, ToolsModule) resolves the
    // card/modal adapter; without it onboarding degrades to asking Dennis in chat.
    PROJECT_ONBOARD_PRESENTER,
    // Exported so the harness's rotate_keys tool + the credential-health guard resolve the
    // card/modal adapter; without it rotation degrades to asking Dennis in chat.
    ROTATE_KEYS_PRESENTER,
    // Like PROPOSAL_PRESENTER, BOARD_NOTIFIER must be exported for the global module to reach
    // UpdateBoardTaskTool (registered in ToolsModule, which imports SlackSurfaceModule globally).
    BOARD_NOTIFIER,
    SlackChatSurface,
    SlackInboundRouter,
    SlackSocketTransport,
  ],
})
export class SlackSurfaceModule {}
