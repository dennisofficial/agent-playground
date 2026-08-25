import { ENGINEERING_STAGES } from '../agent';
import { hasOrgInstructions } from '../conditions';
import { Fragment, FragmentGroup } from '../fragment.decorator';
import type { PromptCtx } from '../prompt-ctx';

@FragmentGroup()
export class OperatorGroup {
  @Fragment({
    usedBy: ENGINEERING_STAGES,
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
