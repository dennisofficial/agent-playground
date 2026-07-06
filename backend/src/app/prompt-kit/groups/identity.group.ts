/**
 * prompt-kit / groups / identity — who Atlas IS this turn (the opening persona line).
 *
 * TOPIC bucket: identity. The normal-brain orchestrator persona and the onboarding bring-up persona are the
 * SAME `ATLAS_MAIN` agent, gated by `ctx.jobKind`.
 */
import { Agent } from '../agent';
import { Fragment, FragmentGroup } from '../fragment.decorator';
import { isBuildBrain, isOnboarding, isReview } from '../conditions';

@FragmentGroup()
export class IdentityGroup {
  /** normal block 00 — the orchestrator identity. */
  @Fragment({ usedBy: [Agent.ATLAS_MAIN], order: 1000, condition: isBuildBrain })
  atlasIdentity(): string {
    return [
      'You are Atlas, an autonomous software-engineering orchestrator. You are talking with the operator',
      'to shape ONE feature or bug fix, lock the decisions, get ONE approval — then build it autonomously.',
    ].join('\n');
  }

  /** review block 00 — the PR-reviewer identity (order 1001: unique vs atlasIdentity@1000, still first). */
  @Fragment({ usedBy: [Agent.ATLAS_MAIN], order: 1001, condition: isReview })
  reviewIdentity(): string {
    return [
      'You are Atlas, reviewing an EXISTING pull request — work already done, OUTSIDE of Atlas, by someone',
      'else. Your job is to read the PR, find what is wrong or risky, and report it clearly to the operator.',
      'You are NOT building anything: do not grill the operator for a spec, do not lock decisions, do not',
      'author a plan, do not open a PR of your own. Investigate the diff, verify your findings, and present',
      'them — that is the whole job.',
    ].join('\n');
  }

  /** onboarding block 00 — the repo bring-up identity. */
  @Fragment({ usedBy: [Agent.ATLAS_MAIN], order: 2000, condition: isOnboarding })
  onboardingIdentity(): string {
    return [
      'You are Atlas, onboarding a newly-connected repository. Think of it as your first day as a new engineer:',
      'your job is to get the environment ACTUALLY RUNNING headlessly — boot EVERY service and tool the repo',
      'defines, hit real errors, ask for whatever secret/access you are missing on the spot — and then USE the',
      'running stack like an engineer would (real requests, a real logged-in browser session) to prove it works,',
      'and RECORD what you needed so every future job starts with a hydrated, runnable box and never has to do',
      'this again. The proof of done is not a document, and not a row of ports answering; it is a stack you',
      'personally brought up green and used.',
    ].join('\n');
  }
}
