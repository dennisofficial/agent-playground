/**
 * prompt-kit / jit — the plan-approved base-check seed (content for the `plan-approved` JIT rule).
 *
 * Fired when the operator approves a plan (`agent-session-manager.ts`'s approval handler), BEFORE the build
 * starts. Two distinct phases the seed must not conflate: a MECHANICAL rebase-check (always auto-resolve any
 * git conflict inline — routine, not a reason to stop) followed by a SEMANTIC judgment of whether the
 * approved plan still holds against the rebased base. Typed-function templating (d11): `ctx.baseBranch` /
 * `ctx.buildPath` are typed fields, the wording branches in code.
 */
import type { JitFireCtx, JitRule } from './rule';
import { agentMessage } from '../message';
import { chunkKey } from '../harness/chunk-keys';

/** The plan-approved base-check seed body — same instruction for both build paths (`dispatch_build` branches
 *  internally on `job.buildPath`; the seed doesn't need to choose). */
export function renderPlanApprovedSeed(ctx: JitFireCtx): string {
  const base = ctx.baseBranch ?? 'the base branch';
  return [
    `Your plan was just approved. Before the build starts, check the plan against ${base}:`,
    '',
    `1. MECHANICAL — rebase-check: \`git fetch origin\`, then rebase (or merge) ${base} into this worktree.`,
    'ALWAYS resolve any git-level merge conflict inline yourself — this is routine, not a reason to stop (a',
    'frequent culprit is the committed `.atlas/decisions/index.md` ledger; resolve it like any other file). A',
    'git conflict by itself is NEVER a reason to pause or ask the operator.',
    '',
    `2. SEMANTIC — judge whether the plan STILL MAKES SENSE against the rebased ${base}:`,
    '   - Plan STILL HOLDS: call `dispatch_build` to start the build (it starts the full pipeline or the',
    "     direct implementation per the committed build path — you don't choose, the tool branches on that",
    '     for you).',
    '   - Base already made the plan REDUNDANT (the change landed via another job): do NOT build — tell the',
    '     operator the plan is moot (`ask_question`), or call `hold_build` if they will want to re-plan.',
    '   - Base DIVERGED enough that the plan needs REVISION (the approach/target files/anchors changed):',
    '     call `hold_build(reason)` to return to planning, then revise and re-propose.',
    '',
    'The pause/replan decision is SEMANTIC — does the plan still make sense? — and is independent of whether a',
    'git conflict occurred during the rebase-check.',
  ].join('\n');
}

export const planApprovedRule: JitRule = {
  id: 'plan-approved',
  enabled: true,
  trigger: { kind: 'lifecycle', event: 'plan-approved' },
  delivery: 'host-seed-notice',
  render: (ctx) => agentMessage(renderPlanApprovedSeed(ctx)),
  seed: {
    label: 'Plan approved — checking the base branch before starting',
    chunkKey: (ctx) =>
      chunkKey.planApproved(ctx.decisionRecordId ?? ctx.jobId ?? ''),
  },
};
