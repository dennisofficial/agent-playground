import { IsIn, IsNotEmpty, IsOptional, IsString } from 'class-validator';
import type { EngineAuthMode } from '../../../harness/llm-keys/llm-key.types';

export class PutLlmKeyDto {
  /** WRITE-ONLY: accepted here, encrypted at rest, never returned by any endpoint. */
  @IsString()
  @IsNotEmpty()
  key!: string;
}

export class PutSubscriptionDto {
  /** Which credential funds this provider's ENGINE turns: 'subscription' drives the workspace's own
   * Claude/ChatGPT plan; 'api_key' reverts to metered billing (keeping any stored secret). */
  @IsIn(['api_key', 'subscription'])
  mode!: EngineAuthMode;

  /** WRITE-ONLY subscription credential — a Claude `CLAUDE_CODE_OAUTH_TOKEN` (from `claude
   * setup-token`) or a Codex `auth.json` blob (from `codex login`). Optional: omit to flip the mode
   * only (e.g. pause/resume) without rotating the stored secret. */
  @IsOptional()
  @IsString()
  @IsNotEmpty()
  secret?: string;
}
