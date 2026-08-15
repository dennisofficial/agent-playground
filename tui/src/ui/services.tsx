import type { INestApplicationContext } from "@nestjs/common";
import React, { createContext, useContext, type ReactNode } from "react";
import { AccountsService } from "../app/accounts.service.js";
import { AttentionService } from "../app/attention.service.js";
import { ConversationService } from "../app/conversation.service.js";
import { ConversationStoreRegistry } from "../app/conversation-store.registry.js";
import { GitService } from "../app/git.service.js";
import { HumanVerbsService } from "../app/human-verbs.service.js";
import { JobStartService } from "../app/job-start.service.js";
import { JobTitleService } from "../app/job-title.service.js";
import { SettingsService } from "../app/settings.service.js";
import { ServiceRegistryService } from "../app/service-registry.service.js";
import { SessionManagerService } from "../app/session-manager.service.js";
import { TaskService } from "../app/task.service.js";
import { ThreadSeamService } from "../app/thread-seam.service.js";
import { TransitionReviewService } from "../app/transition-review.service.js";
import { TurnRunnerService } from "../app/turn-runner.service.js";
import { WorkspaceService } from "../app/workspace.service.js";
import { WorktreeService } from "../app/worktree.service.js";

export type Services = {
  workspaceService: WorkspaceService;
  jobStartService: JobStartService;
  /** What a job is called: the model naming it, the human renaming it, and the live value. */
  jobTitleService: JobTitleService;
  settingsService: SettingsService;
  conversationService: ConversationService;
  conversationStores: ConversationStoreRegistry;
  turnRunnerService: TurnRunnerService;
  accountsService: AccountsService;
  attentionService: AttentionService;
  sessionManagerService: SessionManagerService;
  taskService: TaskService;
  /** The job's long-lived processes — what is running, and what has to be reaped when it lets go. */
  serviceRegistryService: ServiceRegistryService;
  /** The two halves of a proposal: the seam DECIDES one, and the review service READS one. */
  threadSeamService: ThreadSeamService;
  transitionReviewService: TransitionReviewService;
  /** The moves Dennis makes himself — start a phase, open a thread, close one. */
  humanVerbsService: HumanVerbsService;
  /** Read-only, for the jobs list's worktree grouping. Writes go through `WorktreeService`. */
  gitService: GitService;
  /** The jobs list's one write: removing a worktree no job is standing in. */
  worktreeService: WorktreeService;
};

export function resolveServices(context: INestApplicationContext): Services {
  return {
    workspaceService: context.get(WorkspaceService),
    jobStartService: context.get(JobStartService),
    jobTitleService: context.get(JobTitleService),
    settingsService: context.get(SettingsService),
    conversationService: context.get(ConversationService),
    conversationStores: context.get(ConversationStoreRegistry),
    turnRunnerService: context.get(TurnRunnerService),
    accountsService: context.get(AccountsService),
    attentionService: context.get(AttentionService),
    sessionManagerService: context.get(SessionManagerService),
    taskService: context.get(TaskService),
    serviceRegistryService: context.get(ServiceRegistryService),
    threadSeamService: context.get(ThreadSeamService),
    transitionReviewService: context.get(TransitionReviewService),
    humanVerbsService: context.get(HumanVerbsService),
    gitService: context.get(GitService),
    worktreeService: context.get(WorktreeService),
  };
}

const ServicesContext = createContext<Services | null>(null);

export function ServicesProvider(props: {
  services: Services;
  children: ReactNode;
}): React.ReactNode {
  return (
    <ServicesContext.Provider value={props.services}>
      {props.children}
    </ServicesContext.Provider>
  );
}

export function useServices(): Services {
  const services = useContext(ServicesContext);
  if (!services) throw new Error("useServices called outside ServicesProvider");
  return services;
}
