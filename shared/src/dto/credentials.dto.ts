/**
 * Credentials API contract (frontend ⇄ backend) for the org's raw API keys — Anthropic, OpenAI, and the
 * GitHub PAT. These are typed, single-valued secrets stored as encrypted columns on `org_credentials`;
 * the wire speaks them by name (no key-agnostic vault indirection). Subscription OAuth accounts are a
 * separate surface (see the agent-credentials DTOs). Values are write-only — reads return presence only.
 */
import { IsOptional, IsString, MaxLength } from 'class-validator';

// ── Request ──

/** Save the org's API keys. Only the included, non-empty fields are written; the rest are untouched. */
export class SaveCredentialsDto {
  @IsOptional()
  @IsString()
  @MaxLength(20_000)
  anthropicApiKey?: string;

  @IsOptional()
  @IsString()
  @MaxLength(20_000)
  openaiApiKey?: string;

  @IsOptional()
  @IsString()
  @MaxLength(20_000)
  githubPat?: string;
}

// ── Responses ──

export interface SaveCredentialsResult {
  ok: boolean;
}

/** Which API keys the org has set. Presence booleans never expose a value. */
export interface CredentialPresence {
  anthropic: boolean;
  openai: boolean;
  github: boolean;
}
