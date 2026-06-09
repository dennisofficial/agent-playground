import { AsyncLocalStorageProviderSingleton } from '@langchain/core/singletons';
import { createJob, getJob, updateJob } from './jobs.js';
import { rememberDeduped } from './memory/dedup.js';
import type { Identity } from './memory/identity.js';
import { type ActionResult, runWorkerTurn } from './worker.js';

/**
 * THE human-in-the-loop chokepoint. An `execute`-mode (write-capable) job is created ONLY here, and this
 * is reached ONLY from a human action — the conductor's `approvePlan`, driven by the terminal `/approve`
 * command (and a future Slack button). It is deliberately NOT a tool the model can call: that is the
 * code-level guarantee replacing the old prompt-only "the sign-off is Dennis's; don't approve on his
 * behalf." The model can produce a plan and surface it; only a human can authorize the build.
 *
 * AUTONOMY-DIAL SEAM: this single function is where the gate is relaxed later. A future per-bot
 * "auto-approve trusted work" policy calls `executeApprovedPlan` directly — one call site, not a refactor.
 */

/** Drop trailing `STATUS: …` line(s) from a worker report, leaving the plan body for the execute job. */
const stripStatusLine = (report: string): string =>
  report.replace(/^[\s>*_-]*STATUS:\s*(DONE|QUESTION|BLOCKED|PROGRESS)\b.*$/gim, '').trimEnd();

export interface ApprovalResult extends ActionResult {
  /** The spawned execute job's id, on success. */
  execJobId?: string;
}

/**
 * Approve a planning job's plan and spawn the build. Validates the job is a plan awaiting approval,
 * captures the approved plan as the contract, records who approved it, and starts a SEPARATE execute
 * job on the cheaper execution tier. Pure function of the job registry — callable from any human-driven
 * surface (terminal command, Slack webhook), never from a model tool.
 */
export function executeApprovedPlan(
  planJobId: string,
  edits?: string,
  approvedBy = 'dennis',
): ApprovalResult {
  const planJob = getJob(planJobId);
  if (!planJob) return { ok: false, reason: `No job "${planJobId}".` };
  if (planJob.mode !== 'plan') return { ok: false, reason: `${planJobId} isn't a planning job.` };
  if (planJob.status !== 'awaiting')
    return {
      ok: false,
      reason: `${planJobId} is ${planJob.status}, not a plan awaiting approval.`,
    };

  // Prefer the plan body with its trailing STATUS line stripped; but if the worker crammed the whole
  // plan INTO the STATUS: QUESTION line (leaving little body), fall back to the full report so we never
  // execute an empty plan.
  const body = stripStatusLine(planJob.lastReport ?? '');
  const plan = body.length >= 40 ? body : (planJob.lastReport ?? '').trim();
  if (!plan)
    return {
      ok: false,
      reason: `${planJobId} has no plan captured yet — let it finish planning first.`,
    };

  // Planning is done: record the approved plan + who approved it on the plan job and close it. (The
  // conductor skips the relay for an approved plan job — the execute job below is what reports back.)
  updateJob(planJobId, {
    status: 'done',
    plan,
    result: plan,
    approvedBy,
    approvedAt: new Date().toISOString(),
  });

  // Capture the approved approach into durable memory so future planning recalls the decision instead of
  // re-asking. reconcile only mines HUMAN chat utterances; an approved plan is bot-authored, so it would
  // otherwise never be remembered. There's no run config here, so construct the approver Identity from
  // the plan job's own scoping (owner bot + company + notify surface).
  const approver: Identity = {
    selfAgent: planJob.ownerBot,
    company: planJob.company,
    participants: [approvedBy],
    speaker: approvedBy,
    surface: planJob.notifyThread,
    isChannel: true,
  };
  void rememberDeduped({
    fact: `Approved plan for "${planJob.task}"${edits ? ' (with edits)' : ''}: ${plan.slice(0, 300)}`,
    tier: 'company',
    id: approver,
  }).catch(() => {});

  // Spawn a SEPARATE execute job: fresh session → the cheaper EXECUTE-tier model (the plan ran on the
  // high-reasoning tier, and a session can't switch models mid-stream), mutations allowed, seeded with
  // the approved plan as its contract. This is the ONLY createJob(..., 'execute') call in the codebase.
  const seeded = `Execute this APPROVED plan, end to end:\n\n${plan}${
    edits ? `\n\nAdjustments from the team to fold in first:\n${edits}` : ''
  }\n\n(Originating request: ${planJob.task})`;
  const execJob = createJob(
    seeded,
    planJob.notifyThread,
    planJob.engine,
    planJob.ownerBot,
    planJob.company,
    'execute',
  );
  updateJob(execJob.id, { planJobId });
  // Detach the background turn from any inherited LangChain callback context (carried from the old
  // approve_plan tool — a LangGraph run's invoke() would otherwise inherit a chat stream's handler and
  // bleed its tokens into the main chat). Harmless for the SDK engines (own subprocess).
  AsyncLocalStorageProviderSingleton.getInstance().run(undefined, () => {
    void runWorkerTurn(execJob.id, seeded);
  });
  return { ok: true, execJobId: execJob.id };
}
