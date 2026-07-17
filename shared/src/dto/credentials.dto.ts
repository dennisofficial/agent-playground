/**
 * Credentials API contract (frontend ⇄ backend). The wire is KEY-AGNOSTIC: it speaks only
 * {@link ECredentialKey}, never domain names like "anthropic" or "github". The generic org secret
 * vault stores/reports secrets by key and attaches no meaning to them; any domain interpretation
 * (which key gates which UI, GitHub App mode, LLM-key validation) lives in the consumer.
 */
import { Type } from 'class-transformer';
import { ArrayMaxSize, IsArray, IsEnum, IsString, MaxLength, ValidateNested } from 'class-validator';
import { ECredentialKey } from '../enums';

// ── Request ──

/** One secret to write: its key and plaintext value. */
export class CredentialEntry {
  @IsEnum(ECredentialKey)
  key!: ECredentialKey;

  @IsString()
  @MaxLength(20_000)
  value!: string;
}

/** Save a batch of secrets. Only the included keys are written; the rest are left untouched. */
export class SaveCredentialsDto {
  @IsArray()
  @ArrayMaxSize(32)
  @ValidateNested({ each: true })
  @Type(() => CredentialEntry)
  entries!: CredentialEntry[];
}

// ── Responses ──

export interface SaveCredentialsResult {
  ok: boolean;
}

/**
 * Which secrets the org has, keyed by {@link ECredentialKey}. Presence booleans never expose a value.
 * The consumer maps keys to its own domain view (e.g. `present[GITHUB_PAT]` → "GitHub connected").
 */
export interface CredentialPresence {
  present: Partial<Record<ECredentialKey, boolean>>;
}
