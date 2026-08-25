import { Injectable } from '@nestjs/common';
import {
  buildAgentCredentialView,
  planLabel,
  snapshotToUsage,
  type AccountUsage,
  type AccountUsageSnapshot,
  type AgentCredentialView,
  type RawAgentCredential,
} from '@workspace/shared';

export type AgentCredentialViewInput = RawAgentCredential;

@Injectable()
export class AgentCredentialViewService {
  project(input: AgentCredentialViewInput): AgentCredentialView {
    return buildAgentCredentialView(input);
  }

  planLabel(subscriptionType: string | null): string | null {
    return planLabel(subscriptionType);
  }

  snapshotToUsage(snap: AccountUsageSnapshot | null): AccountUsage | null {
    return snapshotToUsage(snap);
  }
}
