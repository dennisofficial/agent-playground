import { agentMessage, type AgentMessage } from '../message';
import { CODEX_TASK_LIST_NOTE, COMMIT_AND_PUSH_NOTE } from '../system';
import type { DecisionRecord, Step } from '../../domain';
import type { TaskItem } from '../../persistence/entities';
import type { ResolvedRepo } from '../../driver/repo-resolver';
import type { DriverThread } from '../../driver/driver-store.service';

/**
 * prompt-kit / messages / batch-task — the driver-run turn bodies: the orchestrator's batch task, the
 * ship-time master-review task, the verification-gate task, and the carried-task-list blocks (rotation seed
 * + done-gate retry) folded into those turns.
 */

/** Render the still-OPEN task-list items into a `<carried_tasks>` block for the fresh Leg's seed (B5). The
 *  durable `threads.tasks` outlives the abandoned session's in-memory to-do, so the fresh Leg keeps its
 *  checklist. Returns '' when nothing is open (all done / no list) — the caller then omits the block. */
export function renderOpenLegTasks(tasks: TaskItem[]): AgentMessage {
  const open = tasks.filter((t) => t.status === 'pending' || t.status === 'in_progress');
  if (!open.length) return agentMessage('');
  const lines = open.map((t) => `- [${t.status === 'in_progress' ? '~' : ' '}] ${t.subject}`);
  return agentMessage(
    [
      '<carried_tasks>',
      "Your task list carried across the rotation (the previous session's in-memory to-do is gone; this is the",
      'durable checklist). Continue these — do NOT recreate completed items or restart finished ones:',
      ...lines,
      '</carried_tasks>',
    ].join('\n'),
  );
}

/** The warning-retry payload for the done-gate task double-check. Lists the still-OPEN tasks and directs the
 *  model to reconcile each before re-asserting `done`. The caller only builds this when `open` is non-empty,
 *  so it never renders an empty block. This is the model's ONE reminder — anything still open after the next
 *  `complete_thread` is host-dropped from the checklist at the done transition. */
export function renderOpenTasksWarning(open: TaskItem[]): AgentMessage {
  const lines = open.map((t) => `- [${t.status === 'in_progress' ? '~' : ' '}] ${t.subject}`);
  return agentMessage(
    [
      `NOT marked done yet — your task list still has ${open.length} open item(s). Reconcile it before you`,
      'assert done. For EACH task below: if the work is genuinely finished, mark it completed' +
        ' (`TaskUpdate` status: completed); if it still needs doing, DO it now (commit + push any changes),' +
        ' then mark it completed; if it is no longer needed, delete it (`TaskUpdate` status: deleted). Then',
      'call `complete_thread` again. This is your ONE reminder — anything still open after your next',
      '`complete_thread` will be dropped from the checklist.',
      '<open_tasks>',
      ...lines,
      '</open_tasks>',
    ].join('\n'),
  );
}

/** Render the ORCHESTRATOR turn's task — ONE turn owns the whole thread. The single step's brief is the
 *  thread brief; the orchestrator reads the real plan in `/context/specs` and decomposes the work live. */
export function renderBatchTask(
  record: DecisionRecord | null,
  thread: DriverThread,
  steps: Step[],
): AgentMessage {
  const decisions = record?.decisions.length
    ? record.decisions
        .map((d) => `- [${d.decisionClass}] ${d.title}: ${d.ruling}`)
        .join('\n')
    : '(none)';
  const blocks = steps
    .map(
      (p, i) => `### Step ${i + 1}: ${p.title ?? `#${p.ordinal}`}\n${p.brief}`,
    )
    .join('\n\n');
  return agentMessage(
    [
      `Feature overview:\n${record?.overview ?? ''}`,
      `\nLocked decisions (respect these):\n${decisions}`,
      `\nThread: ${thread.brief}`,
      `\nYour grounding is \`/context/specs/\` — read its \`plan.md\` index, this thread's \`sections/NN-*.md\`` +
        ` file, and \`data-model.md\`; treat \`/context/specs\` and \`/context/generated\` as READ-ONLY. Make ALL` +
        ` code changes under \`/workspace\`. The one \`/context\` bucket you may write is \`/context/artifacts/\`:` +
        ` leave your live-validation evidence there (logs, screenshots, a \`RESULTS.md\` index) so it surfaces in` +
        ` the operator's ARTIFACTS panel.`,
      // Advisory orientation cheat-sheet, when a prior pass captured one (may be absent — the fresh session
      // then orients off the repo docs itself). Kept subordinate to the code + specs (authoritative).
      ...(thread.orientation
        ? [
            `\nRepo orientation (a cheat-sheet from an earlier pass — the CODE and \`/context/specs/\` remain` +
              ` authoritative if anything here is stale):\n` +
              thread.orientation,
          ]
        : []),
      `\nImplement this thread: read the specs, then delegate the work to writer subagents (one at a time),` +
        ` making small edits yourself where a subagent would be overkill, and verify the whole thread before` +
        ` finishing. If you hit a decision the locked plan does NOT cover: if a one-line human answer would` +
        ` unblock you right now, call \`request_operator_input\` and wait; if you genuinely cannot make progress` +
        ` this turn (a missing secret/service, or a substantive decision that needs deliberation), call` +
        ` \`block_thread\` to hand it to Atlas rather than guessing or stopping silently.\n\n${blocks}`,
      COMMIT_AND_PUSH_INSTRUCTION,
    ].join('\n'),
  );
}

/**
 * The batch writer's commit instruction — the shared `COMMIT_AND_PUSH_NOTE`, prefixed with the leading
 * newline the surrounding task body splices on. YOU (the writer session) own the commit: the host reads what
 * you leave and does NOT commit for you, so leave a CLEAN tree before you call `complete_thread`.
 */
export const COMMIT_AND_PUSH_INSTRUCTION: AgentMessage = agentMessage('\n' + COMMIT_AND_PUSH_NOTE);

/**
 * The task for the MASTER-REVIEW thread — a Codex `execute` turn that reviews the whole merged feature diff
 * and applies fixes IN-CONTAINER (where the repo toolchain lives), then verifies with the repo's own build.
 * Execute-voice counterpart to the old read-only `run_master_review` tool prompt. No writer-subagent mention
 * (Codex has none). Does NOT push — the host commits the edits and ships.
 */
export function renderMasterReviewTask(record: DecisionRecord | null, repo: ResolvedRepo): AgentMessage {
  const decisions = record?.decisions.length
    ? record.decisions.map((d) => `- [${d.decisionClass}] ${d.title}: ${d.ruling}`).join('\n')
    : '(none)';
  return agentMessage(
    [
      `Feature overview:\n${record?.overview ?? ''}`,
      `\nLocked decisions (respect these):\n${decisions}`,
      `\nThis is the FINAL review-and-fix pass over the whole feature branch before its pull request opens.`,
      `\nTRACK YOUR WORK: ${CODEX_TASK_LIST_NOTE} Up front, \`task_create\` one task for each step below.`,
      `\n1. Review the whole merged diff: \`git diff origin/${repo.defaultBranch}...HEAD\`. Look for real,` +
        ` in-scope defects — correctness bugs, security issues, and cross-thread integration mistakes (where` +
        ` two threads' changes don't line up). Ignore style nits and anything outside this feature's scope.`,
      `\n2. FIX what you find: the smallest safe change per finding, never expanding scope; skip anything` +
        ` unsafe or ambiguous rather than guessing. Make edits directly under \`/workspace\`.`,
      `\n3. VERIFY: run the repo's own typecheck/build/test commands and confirm they pass — do this even if` +
        ` you changed nothing (a clean review still deserves a green build). If verification fails, fix and` +
        ` re-verify rather than leaving it red.`,
      `\n4. COMMIT: if you made fixes, \`git add -A\`, commit with a clear message, and \`git push\` — leave a` +
        ` CLEAN tree. Do NOT open a PR (Atlas does the final ship). If the review found nothing actionable,` +
        ` change nothing and skip the commit.`,
      `\n5. FINISH: when done and the build is green (and your fixes, if any, are committed + pushed), you MUST` +
        ` call the \`complete_thread\` host tool (available via the "atlasbridge" MCP server) with a one-line` +
        ` \`summary\` of what you reviewed/fixed and the \`verification\` you ran. This is how you signal` +
        ` completion — the review is NOT recorded as done until you call it. If you genuinely cannot proceed,` +
        ` call \`block_thread\` with a reason and detail instead.`,
    ].join('\n'),
  );
}

/** The task for a verification-gate turn (ADR 0004 rider 3) — resumes the SAME orchestrator session after
 *  it claimed `done`, to run a real diagnostics + typecheck pass before the driver trusts the claim.
 *  `priorErrors` carries the previous iteration's reported remainder, when this is a retry. */
export function renderGateTask(
  changedFiles: string[],
  iteration: number,
  priorErrors: string[],
): AgentMessage {
  const fileList = changedFiles.map((f) => `- ${f}`).join('\n');
  const priorBlock = priorErrors.length
    ? `\nYour last attempt still left these unresolved:\n${priorErrors.map((e) => `- ${e}`).join('\n')}\n`
    : '';
  return agentMessage(
    [
      `Verification gate (required before your work is accepted) — attempt ${iteration}.`,
      `\nThis thread's changes touched these files:\n${fileList}`,
      priorBlock,
      `\n1. Run \`mcp__atlas-lsp-ts__diagnostics\` on each changed file above — a fast per-file check.`,
      `\n2. Run the repo's own typecheck command (authoritative, whole-program) — discover it the same way` +
        ` you would for a normal build (package.json scripts / repo conventions).`,
      `\n3. Fix every error you find, in THIS session, then re-run both checks to confirm they're clean.`,
      `\n4. COMMIT: once both checks are clean, \`git add -A\`, commit any fixes with a clear message, and` +
        ` \`git push\` — leave a CLEAN working tree (the host does NOT commit for you; it reads what you leave).`,
      `\nWhen both are clean AND your tree is committed + pushed, call \`report_verification\` with` +
        ` \`{ passed: true }\`. If you cannot get the checks clean, call \`report_verification\` with` +
        ` \`{ passed: false, remaining: [...] }\`, listing the specific remaining errors (file:line — message)` +
        ` — never end the turn without calling one or the other.`,
    ]
      .filter(Boolean)
      .join('\n'),
  );
}
