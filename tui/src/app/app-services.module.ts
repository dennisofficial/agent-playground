import { Module } from "@nestjs/common";
import { AuthModule } from "../auth/auth.module.js";
import { EngineModule } from "../engine/engine.module.js";
import { AccountRotatorService } from "./account-rotator.service.js";
import { AccountUsageService } from "./account-usage.service.js";
import { AccountsService } from "./accounts.service.js";
import { AttentionService } from "./attention.service.js";
import { ContextFolderService } from "./context-folder.service.js";
import { ContextPressureService } from "./context-pressure.service.js";
import { ConversationService } from "./conversation.service.js";
import { ConversationStoreRegistry } from "./conversation-store.registry.js";
import { GitService } from "./git.service.js";
import { GithubCliService } from "./github-cli.service.js";
import { HumanVerbsService } from "./human-verbs.service.js";
import { JobStartService } from "./job-start.service.js";
import { JobTitleService } from "./job-title.service.js";
import { PhaseBriefService } from "./phase-brief.service.js";
import { ServiceRegistryService } from "./service-registry.service.js";
import { SessionManagerService } from "./session-manager.service.js";
import { ShipService } from "./ship.service.js";
import { TaskService } from "./task.service.js";
import { ThreadSeamService } from "./thread-seam.service.js";
import { TransitionReviewService } from "./transition-review.service.js";
import { TurnRunnerService } from "./turn-runner.service.js";
import { WorkspaceService } from "./workspace.service.js";
import { WorktreeService } from "./worktree.service.js";

@Module({
  imports: [EngineModule, AuthModule],
  providers: [
    ConversationStoreRegistry,
    ContextFolderService,
    ContextPressureService,
    ServiceRegistryService,
    SessionManagerService,
    AccountRotatorService,
    AccountUsageService,
    AccountsService,
    AttentionService,
    PhaseBriefService,
    TurnRunnerService,
    ThreadSeamService,
    TransitionReviewService,
    HumanVerbsService,
    ConversationService,
    TaskService,
    GitService,
    GithubCliService,
    ShipService,
    WorktreeService,
    WorkspaceService,
    JobStartService,
    JobTitleService,
  ],
  exports: [
    ConversationStoreRegistry,
    ContextFolderService,
    ServiceRegistryService,
    SessionManagerService,
    AccountsService,
    AttentionService,
    TurnRunnerService,
    ThreadSeamService,
    TransitionReviewService,
    HumanVerbsService,
    ConversationService,
    TaskService,
    // Exported for the jobs list, which reads `git worktree list` to group by worktree. The only
    // place the UI touches git directly, and it is a read — every WRITE still goes through
    // `WorktreeService`, because that is the rule that keeps `Job.workspacePath` true.
    GitService,
    WorktreeService,
    WorkspaceService,
    JobStartService,
    JobTitleService,
  ],
})
export class AppServicesModule {}
