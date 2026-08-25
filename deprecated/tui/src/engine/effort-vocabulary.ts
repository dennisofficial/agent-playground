import type { EffortLevel } from '@anthropic-ai/claude-agent-sdk';
import type { CodexEffort } from '@workspace/codex-sdk';
import type { EClaudeEffort, ECodexEffort } from '../domain/role-engine.js';

/**
 * The tripwire under the two hand-pinned effort vocabularies.
 *
 * `EClaudeEffort` and `ECodexEffort` live in `domain/`, whose one rule is that it imports nothing
 * from an SDK — which is right, and is why they were transcribed by hand in the first place. The
 * cost of transcription is that an SDK adding, renaming or dropping a level is SILENT: Atlas simply
 * lacks it, and nobody finds out until a role binding cannot say what it means.
 *
 * The fix belongs on the far side of the seam rather than in a weakening of it. `engine/` may see
 * SDK types, so the comparison happens here and `domain/` stays pure and testable without an SDK.
 *
 * Nothing imports these constants and nothing should: they exist to be TYPE-CHECKED. `pnpm
 * typecheck` fails here, naming the member and the file to edit, the moment the two disagree in
 * either direction.
 */
type InSync<
  Sdk extends string,
  Ours extends string,
  Name extends string,
> = [Exclude<Sdk, Ours>] extends [never]
  ? [Exclude<Ours, Sdk>] extends [never]
    ? true
    : `${Name} in domain/role-engine.ts declares '${Exclude<Ours, Sdk>}', which its SDK does not — remove it there`
  : `The SDK gained effort level '${Exclude<Sdk, Ours>}', which ${Name} in domain/role-engine.ts lacks — add it there`;

/**
 * Template-literal interpolation (`${EClaudeEffort}`) is what turns an enum TYPE into the union of
 * its string VALUES, which is the only form comparable with an SDK's plain string union.
 */
export const CLAUDE_EFFORT_IN_SYNC: InSync<
  EffortLevel,
  `${EClaudeEffort}`,
  'EClaudeEffort'
> = true;

export const CODEX_EFFORT_IN_SYNC: InSync<
  CodexEffort,
  `${ECodexEffort}`,
  'ECodexEffort'
> = true;
