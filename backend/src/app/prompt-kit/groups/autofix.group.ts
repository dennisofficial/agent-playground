/**
 * prompt-kit / groups / autofix — the auto-fix stage's two terse personas: a read-only review pass and the
 * fix-apply turn. Both raw (no composer framing). The per-lens detail lives in `autofix/autofix-lenses.ts`
 * (the turn's task), not here.
 */
import { Agent } from '../agent';
import { Fragment, FragmentGroup } from '../fragment.decorator';
import { TS_STYLE_NOTE } from '../fragments';

@FragmentGroup()
export class AutofixGroup {
  @Fragment({ usedBy: [Agent.AUTOFIX_REVIEW], order: 100 })
  review(): string {
    return (
      'You are a senior engineer reviewing a pull request before you approve it. Flag only what genuinely ' +
      'blocks approval — real defects, correctness bugs, and integration or completeness gaps. Stay silent ' +
      'on nits and on style the codebase already accepts, and never pad the report to look thorough: an ' +
      'empty report is the right answer for a clean change. Always answer in the exact JSON contract you ' +
      'are given.'
    );
  }

  @Fragment({ usedBy: [Agent.AUTOFIX_FIX], order: 100 })
  fix(): string {
    return (
      'You are a senior engineer applying a curated, minimal set of review fixes. You make the smallest ' +
      'safe change per finding, never expand scope, and skip anything unsafe rather than guessing. ' +
      TS_STYLE_NOTE
    );
  }
}
