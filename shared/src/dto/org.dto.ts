/**
 * Organization API contract (frontend ⇄ backend). Request DTOs are class-validator classes;
 * response shapes are interfaces.
 */
import { IsBoolean, IsOptional, IsString, MaxLength, MinLength } from 'class-validator';

// ── Requests ──

export class CreateOrgDto {
  @IsString()
  @MinLength(1)
  @MaxLength(80)
  name!: string;
}

export class UpdateOrgDto {
  @IsOptional()
  @IsString()
  @MaxLength(80)
  name?: string;

  @IsOptional()
  @IsBoolean()
  defaultAutoApprove?: boolean;

  @IsOptional()
  @IsBoolean()
  defaultAutoShip?: boolean;

  @IsOptional()
  @IsBoolean()
  defaultAutoMerge?: boolean;
}

// ── Responses ──

/**
 * An organization the current user belongs to. Returned on the session payload
 * (`GET /auth/session`) and by the org CRUD endpoints. `role` is the *caller's*
 * role in this org. The three `default*` flags are the org-level defaults applied
 * when a job is created (auto-advance the plan gate, the ship gate, auto-merge the PR).
 */
export interface OrgSummary {
  id: string;
  name: string;
  /** `EOrgStatus` value on the wire ('onboarding' | 'active' | 'suspended'). */
  status: string;
  /** The caller's `EOrgRole` value in this org ('owner' | 'member'). */
  role: string;
  defaultAutoApprove: boolean;
  defaultAutoShip: boolean;
  defaultAutoMerge: boolean;
}

/** A member of an organization, returned by `GET /orgs/:orgId/members`. */
export interface MemberView {
  userId: string;
  email: string;
  name: string | null;
  /** `EOrgRole` value on the wire ('owner' | 'member'). */
  role: string;
}
