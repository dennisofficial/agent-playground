import { AsyncLocalStorageProviderSingleton } from '@langchain/core/singletons';
import { getBoard } from './board/index.js';
import { botById, ROSTER } from './employees/index.js';
import { createJob, getJob, listJobs, updateJob } from './jobs.js';
import { rememberDeduped } from './memory/dedup.js';
import { DEFAULT_TEAM, type Identity } from './memory/identity.js';
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
export const stripStatusLine = (report: string): string =>
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
  // the plan job's own scoping (owner bot + project + notify surface).
  const approver: Identity = {
    selfAgent: planJob.ownerBot,
    // A job is scoped to a project, not a team — so reconstruct project from the job; team falls back to
    // the default (the team tier isn't carried on a Job).
    team: DEFAULT_TEAM,
    project: planJob.project,
    participants: [approvedBy],
    speaker: approvedBy,
    surface: planJob.notifyThread,
    isChannel: true,
  };
  void rememberDeduped({
    // A bare approval fact — just the decision. The full plan is already seeded into the execute job
    // below, so storing a 300-char slice here only pollutes semantic recall with an un-dedupable blob.
    fact: `Approved plan for "${planJob.task}"${edits ? ' (with edits)' : ''}.`,
    tier: 'project',
    id: approver,
  }).catch(() => {});

  // Spawn a SEPARATE execute job: fresh session → the cheaper EXECUTE-tier model (the plan ran on the
  // high-reasoning tier, and a session can't switch models mid-stream), mutations allowed, seeded with
  // the approved plan as its contract. One of only TWO sanctioned createJob(..., 'execute') paths — this
  // (per-plan human approval) and `executeTicketPlan` below (standup-approved ticket); no model tool ever
  // creates an execute job directly.
  const seeded = `Execute this APPROVED plan, end to end:\n\n${plan}${
    edits ? `\n\nAdjustments from the team to fold in first:\n${edits}` : ''
  }\n\n(Originating request: ${planJob.task})`;
  const execJob = createJob(
    seeded,
    planJob.notifyThread,
    planJob.engine,
    planJob.ownerBot,
    planJob.project,
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

/**
 * Execute a STANDUP-APPROVED ticket's plan — the autonomy seam. Unlike `executeApprovedPlan` (human-only),
 * this IS model-callable (via the `execute_ticket` tool): the work was already approved at standup, so
 * there's no second per-build gate. The write-safety invariant holds because it runs ONLY the frozen
 * `approvedMd` snapshot (never the editable draft), only for an `approved`/`in_progress` ticket, and only
 * the caller's own discipline plan. Several disciplines can build one ticket at once (different owner bots);
 * the same bot can't double-start its own plan. The ticket goes `in_progress`; the conductor flips it to
 * `done` when the last discipline's job finishes (and `blocked` if the scrum master halts it).
 */
export function executeTicketPlan(
  ticketId: string,
  botId: string,
  project: string,
  surface: string,
): ApprovalResult {
  const board = getBoard();
  const ticket = board.getTicket(project, ticketId);
  if (!ticket) return { ok: false, reason: `No ticket "${ticketId}".` };
  if (ticket.status !== 'approved' && ticket.status !== 'in_progress')
    return {
      ok: false,
      reason: `${ticket.id} is ${ticket.status} — only an approved ticket can be built (its plan was signed off at standup).`,
    };
  const plan = board.getPlan(project, ticketId, botId);
  if (!plan || !plan.approvedMd.trim())
    return { ok: false, reason: `${ticket.id} has no approved plan for ${botId} to build.` };
  // One execute run per discipline at a time: don't let the same bot start its plan twice.
  const alreadyRunning = listJobs().some(
    (j) =>
      j.ticketId === ticketId &&
      j.ownerBot === botId &&
      j.mode === 'execute' &&
      (j.status === 'running' || j.status === 'awaiting'),
  );
  if (alreadyRunning)
    return { ok: false, reason: `You're already building ${ticket.id} — let that run finish.` };

  const bot = botById(botId) ?? ROSTER[0];
  const seeded = `Execute this APPROVED plan for ticket ${ticket.id} ("${ticket.title}"), end to end:\n\n${plan.approvedMd}\n\n(This plan was approved at standup — build exactly it. If the plan itself is wrong or the scope is materially larger than it describes, STOP with STATUS: QUESTION rather than expanding it.)`;
  const execJob = createJob(seeded, surface, bot.engine, botId, project, 'execute');
  updateJob(execJob.id, { ticketId, approvedAt: plan.approvedAt });
  board.setStatus(project, ticketId, 'in_progress');
  AsyncLocalStorageProviderSingleton.getInstance().run(undefined, () => {
    void runWorkerTurn(execJob.id, seeded);
  });
  return { ok: true, execJobId: execJob.id };
}
