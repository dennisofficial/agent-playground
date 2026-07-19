/**
 * Repository API contract (frontend ⇄ backend). Request DTOs are class-validator classes;
 * response shapes are interfaces. A repo is connected under an org and is the unit threads/jobs
 * attach to.
 */
import { IsBoolean, IsIn, IsOptional, IsString, MaxLength } from 'class-validator';
import { AUTO_MERGE_METHODS, type AutoMergeMethod } from '../types/auto-merge';

/** `POST /orgs/:orgId/repos` — connect a GitHub repo to the org by URL. */
export class ConnectRepoDto {
  @IsString()
  @MaxLength(300)
  repoUrl!: string;

  @IsOptional()
  @IsString()
  @MaxLength(120)
  displayName?: string;

  @IsOptional()
  @IsString()
  @MaxLength(200)
  baseBranch?: string;
}

/** `PATCH /orgs/:orgId/repos/:repoId` — metadata only; makes no GitHub call. */
export class UpdateRepoDto {
  @IsOptional()
  @IsString()
  @MaxLength(120)
  name?: string;

  @IsOptional()
  @IsString()
  @MaxLength(200)
  defaultBranch?: string;

  /** `''` clears the override back to the neutral built-in default. */
  @IsOptional()
  @IsString()
  @MaxLength(80)
  branchPrefix?: string;

  @IsOptional()
  @IsIn(AUTO_MERGE_METHODS)
  defaultAutoMergeMethod?: AutoMergeMethod;

  @IsOptional()
  @IsBoolean()
  defaultAutoMergeDeleteBranch?: boolean;
}

/**
 * Enriched repo shape returned by the list endpoint (`GET /orgs/:orgId/repos`) and the realtime
 * feed. Carries the derived fields (`threadCount`, onboarding/access timestamps) that the single
 * mutation result (`ConnectedRepo`) omits.
 */
export interface RepoView {
  id: string;
  /** The owning org — lets a cross-org repo list (`GET /repos`) group by org without a second lookup. */
  orgId: string;
  slug: string;
  name: string;
  gitUrl: string;
  defaultBranch: string;
  accessOk: boolean;
  /** ISO timestamp of the last access validation, or null if never checked. */
  accessCheckedAt: string | null;
  /** Threads living on this repo — gates whether it can be disconnected. */
  threadCount: number;
  /** The repo's current onboarding thread id, or null if never started. */
  onboardingThreadId: string | null;
  /** ISO timestamp when onboarding completed (workspace config live), or null until then. */
  onboardedAt: string | null;
  /** Non-fatal webhook-registration warning, or null when hooks are healthy. */
  webhookWarning: string | null;
  /** Per-repo feature-branch prefix override; null → neutral built-in default. */
  branchPrefix: string | null;
  defaultAutoMergeMethod: AutoMergeMethod;
  defaultAutoMergeDeleteBranch: boolean;
}

/**
 * The result of a connect / revalidate / update mutation. Deliberately narrower than `RepoView`
 * (no derived thread/onboarding fields — the client refetches the enriched list for those).
 * `reason` is present on a failed access probe (the GitHub reason).
 */
export interface ConnectedRepo {
  id: string;
  slug: string;
  name: string;
  gitUrl: string;
  defaultBranch: string;
  branchPrefix: string | null;
  defaultAutoMergeMethod: AutoMergeMethod;
  defaultAutoMergeDeleteBranch: boolean;
  accessOk: boolean;
  reason?: string;
}

/** `GET /orgs/:orgId/repos/:repoId/branches` — live branch list, default branch first. */
export interface RepoBranches {
  branches: string[];
  defaultBranch: string;
}

/** `DELETE /orgs/:orgId/repos/:repoId` result. */
export interface DisconnectRepoResult {
  ok: boolean;
  threadsDeleted: number;
}
