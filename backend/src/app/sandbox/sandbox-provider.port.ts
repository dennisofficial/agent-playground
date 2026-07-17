import type { ResolvedMcpServer } from '@shared/engine/engine.types';
import { FeatureSandbox } from '../git/local-git.service';

export const SANDBOX_PROVIDER = Symbol('SANDBOX_PROVIDER');

export type SandboxMilestoneStage = 'image_build' | 'container_create';

export interface SandboxMount {
  path: string;
  mode: 'per-thread' | 'shared-ro' | 'shared-rw';
}

export type ServiceLivenessProbe =
  | { status: 'unknown' }
  | { status: 'down' }
  | { status: 'up'; containerStartedAt: string; alive: number[] };

export interface SandboxAttachInput {
  sandbox: FeatureSandbox;
  orgId: string;
  jobId?: string;
  repoDbId?: string;
  mounts?: SandboxMount[];
  setupScript?: string | null;
  onMilestone?: (stage: SandboxMilestoneStage) => void;
}

export interface SetupScriptResult {
  ok: boolean;
  exitCode: number;
  tail: string;
}

export interface SandboxProvider {
  attach(input: SandboxAttachInput): Promise<FeatureSandbox>;
  teardown(sandbox: FeatureSandbox): Promise<void>;
  contextDirHost(orgId: string, jobId: string): string;
  playgroundDirHost(orgId: string, jobId: string): string;
  draftUploadsDirHost(orgId: string, jobId: string, userId: string): string;
  brainTranscriptProjectsDir(jobId: string): string | null;
  supervisorDirHost(jobId: string): string | null;
  probeLiveness(jobId: string, pgids: number[]): Promise<ServiceLivenessProbe>;
  teardownByIdentity(input: SandboxAttachInput): Promise<void>;
  reapOrphanedArtifacts?(): Promise<{ networks: number; volumes: number }>;
  writeToJobContainerPath?(input: {
    jobId: string;
    path: string;
    value: string;
    timeoutMs?: number;
  }): Promise<{ ok: boolean; reason?: string }>;

  stopAllServices?(jobId: string): Promise<{ ok: boolean; reason?: string }>;

  kickMcpHubRefresh?(input: { jobId: string; servers: ResolvedMcpServer[] }): Promise<void>;

  sandboxContainerName(jobId: string): string;

  bridgeCaddyToSandbox(jobId: string): Promise<void>;

  unbridgeCaddyFromSandbox(jobId: string): Promise<void>;

  listLiveThreadJobIds(): Promise<string[]>;

  writeGithubTokenFile?(jobId: string, token: string): Promise<void>;
}
