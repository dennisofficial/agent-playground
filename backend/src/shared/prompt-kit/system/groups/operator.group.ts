/**
 * prompt-kit / groups / operator — standing operator/org instructions, appended when present.
 *
 * TOPIC bucket: operator/org customization. This is NEW (no equivalent in the legacy body); it is CONDITIONAL
 * on `ctx.settings.userOrgInstructions`, so when absent the assembled prompt is byte-identical to the legacy
 * composed brain. Ordered `9000` — after everything else, in both the normal and onboarding subsets.
 */
import { Agent } from '../agent';
import { Fragment, FragmentGroup } from '../fragment.decorator';
import { hasOrgInstructions } from '../conditions';
import type { PromptCtx } from '../prompt-ctx';

@FragmentGroup()
export class OperatorGroup {
  /** Standing operator/org instructions for this org (only when set). */
  @Fragment({
    usedBy: [Agent.ATLAS_MAIN],
    order: 9000,
    condition: hasOrgInstructions,
  })
  userCustomInstructions(ctx: PromptCtx): string {
    const instructions = (ctx.settings?.userOrgInstructions ?? '').trim();
    return [
      'OPERATOR / ORG INSTRUCTIONS — standing guidance from this workspace. Follow it unless it conflicts with',
      'a safety rule above, in which case surface the conflict:',
      instructions,
    ].join('\n');
  }
}
