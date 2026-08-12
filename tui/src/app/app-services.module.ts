import { Module } from "@nestjs/common";
import { AuthModule } from "../auth/auth.module.js";
import { EngineModule } from "../engine/engine.module.js";
import { AccountRotatorService } from "./account-rotator.service.js";
import { AccountUsageService } from "./account-usage.service.js";
import { AccountsService } from "./accounts.service.js";
import { AttentionService } from "./attention.service.js";
import { ContextFolderService } from "./context-folder.service.js";
import { ConversationService } from "./conversation.service.js";
import { ConversationStoreRegistry } from "./conversation-store.registry.js";
import { GitService } from "./git.service.js";
import { JobStartService } from "./job-start.service.js";
import { PhaseBriefService } from "./phase-brief.service.js";
import { SessionManagerService } from "./session-manager.service.js";
import { TurnRunnerService } from "./turn-runner.service.js";
import { WorkspaceService } from "./workspace.service.js";
import { WorktreeService } from "./worktree.service.js";

@Module({
  imports: [EngineModule, AuthModule],
  providers: [
    ConversationStoreRegistry,
    ContextFolderService,
    SessionManagerService,
    AccountRotatorService,
    AccountUsageService,
    AccountsService,
    AttentionService,
    PhaseBriefService,
    TurnRunnerService,
    ConversationService,
    GitService,
    WorktreeService,
    WorkspaceService,
    JobStartService,
  ],
  exports: [
    ConversationStoreRegistry,
    ContextFolderService,
    SessionManagerService,
    AccountsService,
    AttentionService,
    TurnRunnerService,
    ConversationService,
    WorktreeService,
    WorkspaceService,
    JobStartService,
  ],
})
export class AppServicesModule {}
