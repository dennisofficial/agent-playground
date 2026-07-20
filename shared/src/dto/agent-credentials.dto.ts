/**
 * Agent SDK credential manager contract (frontend ⇄ backend). Unlike the key-agnostic secret vault,
 * this surface is domain-aware: it speaks providers (Claude/Codex), OAuth login flows, and per-account
 * subscription usage. Token material NEVER crosses this wire — only metadata + usage windows.
 */
import { IsEnum, IsOptional, IsString, IsUUID, MaxLength } from 'class-validator';
import { EAgentCredentialKind, EAgentCredentialStatus, EAgentProvider } from '../enums';
import type { AccountUsage } from '../types/usage';

export interface AgentCredentialView {
  id: string;
  provider: EAgentProvider;
  kind: EAgentCredentialKind;
  /** Human label (defaults to the account email). */
  label: string;
  accountEmail: string | null;
  /** Subscription plan label for the header badge (e.g. "Max plan"); null when unknown / setup-token. */
  plan: string | null;
  status: EAgentCredentialStatus;
  /** The active account for this (org, provider). Exactly one per provider is selected. */
  selected: boolean;
  /** ISO expiry of the current access token; null for non-expiring (setup-token) creds. */
  expiresAt: string | null;
  /** Per-account subscription usage windows; null until a source has reported (Codex, cold Claude). */
  usage: AccountUsage | null;
  createdAt: string;
}

export interface ClaudeAuthorizeUrlResult {
  url: string;
  state: string;
}

export class CreateClaudePersonalDto {
  @IsString()
  @MaxLength(4000)
  code!: string;

  @IsString()
  @MaxLength(500)
  state!: string;
}

export class CreateSetupTokenDto {
  @IsString()
  @MaxLength(20_000)
  setupToken!: string;

  @IsOptional()
  @IsString()
  @MaxLength(200)
  label?: string;
}

export interface CodexDeviceStartResult {
  /** Opaque server-side handle used to poll; NOT the raw device_code. */
  handle: string;
  userCode: string;
  /** Verification URL (the `_complete` variant with the code embedded, when available). */
  verificationUri: string;
  /** Seconds until the device code expires. */
  expiresIn: number;
  /** Minimum seconds between polls. */
  interval: number;
}

export class CodexDevicePollDto {
  @IsString()
  @MaxLength(200)
  handle!: string;
}

export interface CodexDevicePollResult {
  status: 'pending' | 'slow_down' | 'complete' | 'expired' | 'denied';
  credential?: AgentCredentialView;
}

export class PasteCodexAuthDto {
  @IsString()
  @MaxLength(20_000)
  authJson!: string;

  @IsOptional()
  @IsString()
  @MaxLength(200)
  label?: string;
}

export class SetSelectedDto {
  @IsUUID()
  credentialId!: string;
}

export class ProviderParamDto {
  @IsEnum(EAgentProvider)
  provider!: EAgentProvider;
}
