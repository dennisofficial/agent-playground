/**
 * Agent SDK credential manager contract (frontend ⇄ backend). Unlike the key-agnostic secret vault,
 * this surface is domain-aware: it speaks providers (Claude/Codex), OAuth login flows, and per-account
 * subscription usage. Token material NEVER crosses this wire — only metadata + usage windows.
 */
import { IsEnum, IsOptional, IsString, IsUUID, MaxLength } from 'class-validator';
import { EAgentCredentialKind, EAgentCredentialStatus, EAgentProvider } from '../enums';
import type { AccountUsage } from '../types/usage';

// ── Views (responses) ──

/** One agent account, as shown in Settings and streamed over realtime. No token material. */
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

// ── Claude OAuth (authorization-code + PKCE, manual paste-the-code) ──

/** Result of starting the Claude OAuth flow — the URL to open and the state to echo back. */
export interface ClaudeAuthorizeUrlResult {
  url: string;
  state: string;
}

/** Finish Claude OAuth: the `code#state` string the user pasted back, plus the issued state. */
export class CreateClaudePersonalDto {
  @IsString()
  @MaxLength(4000)
  code!: string;

  @IsString()
  @MaxLength(500)
  state!: string;
}

/** Add a Claude setup-token account (`sk-ant-oat…`), no OAuth dance. */
export class CreateSetupTokenDto {
  @IsString()
  @MaxLength(20_000)
  setupToken!: string;

  @IsOptional()
  @IsString()
  @MaxLength(200)
  label?: string;
}

// ── Codex device-code OAuth ──

/** Result of starting the Codex device flow — show the user the code + link, poll with the handle. */
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

/** Poll a running Codex device flow. */
export class CodexDevicePollDto {
  @IsString()
  @MaxLength(200)
  handle!: string;
}

/** Result of a Codex device poll; `credential` is present only once `status === 'complete'`. */
export interface CodexDevicePollResult {
  status: 'pending' | 'slow_down' | 'complete' | 'expired' | 'denied';
  credential?: AgentCredentialView;
}

/** Add a Codex account by pasting `~/.codex/auth.json` (fallback when device login isn't available). */
export class PasteCodexAuthDto {
  @IsString()
  @MaxLength(20_000)
  authJson!: string;

  @IsOptional()
  @IsString()
  @MaxLength(200)
  label?: string;
}

// ── Selection ──

/** Pick the active account for a provider. */
export class SetSelectedDto {
  @IsUUID()
  credentialId!: string;
}

/** Provider is echoed for a couple of endpoints that need it in the body rather than the path. */
export class ProviderParamDto {
  @IsEnum(EAgentProvider)
  provider!: EAgentProvider;
}
