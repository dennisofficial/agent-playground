import { Injectable } from '@nestjs/common';

export interface DriverApprovalHandler {
  resolveShip(jobId: string, ruledBy: string): Promise<void>;
  retractShip(jobId: string, ruledBy: string): Promise<boolean>;
  resolveMerge(jobId: string, ruledBy: string): Promise<boolean>;
  neutralizeAmendProposal(jobId: string, verdictLine: string): Promise<void>;
}

@Injectable()
export class DriverApprovalGateway implements DriverApprovalHandler {
  private handler: DriverApprovalHandler | null = null;

  bind(handler: DriverApprovalHandler): void {
    this.handler = handler;
  }

  private require(): DriverApprovalHandler {
    if (!this.handler) {
      throw new Error(
        'DriverApprovalGateway used before the driver registered itself (DriverModule.onApplicationBootstrap → bind).',
      );
    }
    return this.handler;
  }

  resolveShip(jobId: string, ruledBy: string): Promise<void> {
    return this.require().resolveShip(jobId, ruledBy);
  }

  retractShip(jobId: string, ruledBy: string): Promise<boolean> {
    return this.require().retractShip(jobId, ruledBy);
  }

  resolveMerge(jobId: string, ruledBy: string): Promise<boolean> {
    return this.require().resolveMerge(jobId, ruledBy);
  }

  neutralizeAmendProposal(jobId: string, verdictLine: string): Promise<void> {
    return this.require().neutralizeAmendProposal(jobId, verdictLine);
  }
}
