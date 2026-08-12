import type { INestApplicationContext } from "@nestjs/common";
import React, { createContext, useContext, type ReactNode } from "react";
import { AccountsService } from "../app/accounts.service.js";
import { AttentionService } from "../app/attention.service.js";
import { ConversationService } from "../app/conversation.service.js";
import { ConversationStoreRegistry } from "../app/conversation-store.registry.js";
import { JobStartService } from "../app/job-start.service.js";
import { SessionManagerService } from "../app/session-manager.service.js";
import { TurnRunnerService } from "../app/turn-runner.service.js";
import { WorkspaceService } from "../app/workspace.service.js";

export type Services = {
  workspaceService: WorkspaceService;
  jobStartService: JobStartService;
  conversationService: ConversationService;
  conversationStores: ConversationStoreRegistry;
  turnRunnerService: TurnRunnerService;
  accountsService: AccountsService;
  attentionService: AttentionService;
  sessionManagerService: SessionManagerService;
};

export function resolveServices(context: INestApplicationContext): Services {
  return {
    workspaceService: context.get(WorkspaceService),
    jobStartService: context.get(JobStartService),
    conversationService: context.get(ConversationService),
    conversationStores: context.get(ConversationStoreRegistry),
    turnRunnerService: context.get(TurnRunnerService),
    accountsService: context.get(AccountsService),
    attentionService: context.get(AttentionService),
    sessionManagerService: context.get(SessionManagerService),
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
