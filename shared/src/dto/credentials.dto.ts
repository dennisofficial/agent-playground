/**
 * Credentials API contract (frontend ⇄ backend). The backend stores each value in the generic org
 * secret vault under a typed `ECredentialKey`; this DTO is just the human-facing field mapping the
 * settings UI edits. Request = class-validator class; response shapes = interfaces.
 */
import { IsOptional, IsString, MaxLength } from 'class-validator';

// ── Request ──

/** Save one or more org credentials. Every field is optional; only present values are written. */
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

  /** Codex subscription secret (auth.json blob) for the optional Codex coding engine. */
  @IsOptional()
  @IsString()
  @MaxLength(20_000)
  codexAuthSecret?: string;
}

// ── Responses ──

export interface ValidationResult {
  ok: boolean;
  reason?: string;
}

/** Result of `PUT /orgs/:orgId/credentials`. `validation.llmKey` is set when an LLM key was saved. */
export interface SaveCredentialsResult {
  ok: boolean;
  validation: { llmKey?: ValidationResult };
}

/**
 * Which credentials an org has, for the settings UI. Presence booleans never expose the secret.
 *
 * `hasAnthropic`/`hasOpenai`/`hasCodex`/`hasGithub` are served for real by the vault. `llmValidated`
 * (server-probed LLM-key verdict), `githubAuthMode`/`hasGithubApp` (GitHub App state) and
 * `engineAuthSet` (Claude coding-engine subscription) are owned by modules that don't exist yet and
 * are stubbed until they land — see the credentials controller.
 */
export interface CredentialPresence {
  hasAnthropic: boolean;
  hasOpenai: boolean;
  hasGithub: boolean;
  /** A Claude coding-engine subscription token is set (owned by the future engine module). */
  engineAuthSet: boolean;
  /** An optional Codex coding-engine subscription is set. */
  hasCodex: boolean;
  /** The org has connected the Atlas GitHub App (owned by the future GitHub module). */
  hasGithubApp: boolean;
  /** Which GitHub credential resolves for this org: `pat` (default) or `app`. */
  githubAuthMode: 'pat' | 'app';
  /** The stored LLM key passed a server-side probe (owned by the future engine module). */
  llmValidated: boolean;
}
