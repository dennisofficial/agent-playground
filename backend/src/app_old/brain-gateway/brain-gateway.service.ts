import { Injectable, Logger } from '@nestjs/common';
import type { UnblockBlockerInfo } from '../../_shared/domain/message';

export interface BrainGatewayHandler {
  openPrAtShip(input: {
    jobId: string;
    orgId: string;
    repoId: string;
    branch: string;
    defaultBranch: string;
    title: string;
    threadId: string;
  }): Promise<void>;
  seedPreviewOnPostBuild(input: {
    jobId: string;
    orgId: string;
    repoId: string;
    previewInstructions: string | null;
  }): Promise<void>;
  seedPostBuildGate(input: {
    jobId: string;
    orgId: string;
    repoId: string;
    threadId: string;
  }): Promise<void>;
  recordUnblockNote(
    jobId: string,
    orgId: string,
    repoId: string,
    input: { blockers: UnblockBlockerInfo[] },
  ): Promise<void>;
  pumpUnblockedJob(jobId: string, orgId: string, repoId: string): Promise<void>;
}

@Injectable()
export class BrainGateway implements BrainGatewayHandler {
  private readonly logger = new Logger(BrainGateway.name);
  private handler: BrainGatewayHandler | null = null;

  bind(handler: BrainGatewayHandler): void {
    this.handler = handler;
  }

  private require(): BrainGatewayHandler {
    if (!this.handler) {
      throw new Error(
        'BrainGateway used before the brain registered itself (AgentSessionManager.onApplicationBootstrap → bind).',
      );
    }
    return this.handler;
  }

  openPrAtShip(input: Parameters<BrainGatewayHandler['openPrAtShip']>[0]): Promise<void> {
    return this.require().openPrAtShip(input);
  }

  seedPreviewOnPostBuild(
    input: Parameters<BrainGatewayHandler['seedPreviewOnPostBuild']>[0],
  ): Promise<void> {
    return this.require().seedPreviewOnPostBuild(input);
  }

  seedPostBuildGate(input: Parameters<BrainGatewayHandler['seedPostBuildGate']>[0]): Promise<void> {
    return this.require().seedPostBuildGate(input);
  }

  recordUnblockNote(
    jobId: string,
    orgId: string,
    repoId: string,
    input: { blockers: UnblockBlockerInfo[] },
  ): Promise<void> {
    return this.require().recordUnblockNote(jobId, orgId, repoId, input);
  }

  pumpUnblockedJob(jobId: string, orgId: string, repoId: string): Promise<void> {
    return this.require().pumpUnblockedJob(jobId, orgId, repoId);
  }
}
