import { agentMessage, type AgentMessage } from '@shared/prompt-kit/message';
import { COMMIT_AND_PUSH_NOTE, TASK_LIST_NOTE } from '@shared/prompt-kit/system';
import type { DecisionRecord, Step } from '@shared/domain';
import type { TaskItem } from '../../persistence/entities';
import type { ResolvedRepo } from '../../driver/repo-resolver';
import type { DriverThread } from '../../driver/driver-store.service';

/**
 * prompt-kit / messages / batch-task — the driver-run turn bodies: the orchestrator's batch task, the
 * ship-time master-review task, the verification-gate task, and the carried-task-list blocks (rotation seed
 * + done-gate retry) folded into those turns.
 */

/** Render the still-OPEN task-list items into a `<carried_tasks>` block for the fresh Leg's seed (B5). The
 *  durable stage-owned `tasks` table outlives the abandoned session's in-memory to-do, so the fresh Leg
 *  keeps its checklist. Returns '' when nothing is open (all done / no list) — the caller then omits the
 *  block. */
export function renderOpenLegTasks(tasks: TaskItem[]): AgentMessage {
  const open = tasks.filter(
    (t) => t.status === 'pending' || t.status === 'in_progress',
  );
  if (!open.length) return agentMessage('');
  const lines = open.map(
    (t) => `- [${t.status === 'in_progress' ? '~' : ' '}] ${t.subject}`,
  );
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

/** The ADVISORY payload for the done-gate task double-check. The checklist is advisory at completion — it
 *  NEVER blocks `complete_thread`; the done assertion latches and the host force-closes any leftover open
 *  items to `dropped` (`dropOpenThreadTasks`). This note just informs the model which items it left open so
 *  it can reconcile them next time. The caller only builds it when `open` is non-empty. */
export function renderOpenTasksAdvisory(open: TaskItem[]): AgentMessage {
  const lines = open.map(
    (t) => `- [${t.status === 'in_progress' ? '~' : ' '}] ${t.subject}`,
  );
  return agentMessage(
    [
      `Done recorded. Note: your task list still had ${open.length} open item(s) at completion — they've been`,
      "auto-closed (dropped from the checklist), since the thread is done. This is advisory only; you don't",
      'need to act on it. If any item below still needed real work, that is a genuine gap to flag next time.',
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
  skillNudge: { name: string; reason: string }[] = [],
): AgentMessage {
  const decisions = record?.decisions.length
    ? record.decisions
        .map((d) => `- [${d.decisionClass}] ${d.title}: ${d.ruling}`)
        .join('\n')
    : '(none)';
  // JIT skill-relevance nudge (empty by default — keeps existing callers byte-identical). Directs the model
  // to load a directly-relevant skill with the `Skill` tool before implementing, rather than working from
  // memory when a matching skill exists. Selection is chosen upstream (host-side Haiku selector).
  const skillBlock = skillNudge.length
    ? [
        '\n<available_skills>',
        'A skill that looks directly relevant to THIS thread is available. Before you start implementing,',
        'load it with the `Skill` tool to pull its guidance — do not work from memory when a matching skill exists:',
        ...skillNudge.map((s) => `- \`${s.name}\``),
        '</available_skills>',
      ].join('\n')
    : '';
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
        ` code changes under \`/workspace\`. You may write TWO \`/context\` buckets: \`$ATLAS_EVIDENCE_DIR\`` +
        ` (this thread's evidence folder — leave your live-run proof there: logs, screenshots, a \`RESULTS.md\`` +
        ` index, surfaced in the operator's EVIDENCE panel) and \`/context/artifacts/\` (human-facing DELIVERABLES` +
        ` only — HTML mockups, reports). Live-run evidence goes to \`$ATLAS_EVIDENCE_DIR\`, NOT \`artifacts/\`.`,
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
        ` this turn (a missing secret/service, or a substantive decision that needs deliberation), just end` +
        ` your turn without calling \`complete_thread\` — it surfaces as not-done to the operator` +
        ` automatically, rather than guessing or stopping silently.\n\n${blocks}`,
      ...(skillBlock ? [skillBlock] : []),
      COMMIT_AND_PUSH_INSTRUCTION,
    ].join('\n'),
  );
}

/**
 * The batch writer's commit instruction — the shared `COMMIT_AND_PUSH_NOTE`, prefixed with the leading
 * newline the surrounding task body splices on. YOU (the writer session) own the commit: the host reads what
 * you leave and does NOT commit for you, so leave a CLEAN tree before you call `complete_thread`.
 */
export const COMMIT_AND_PUSH_INSTRUCTION: AgentMessage = agentMessage(
  '\n' + COMMIT_AND_PUSH_NOTE,
);

/**
 * The task for the MASTER-REVIEW thread — a Codex `execute` turn that reviews the whole merged feature diff
 * and applies fixes IN-CONTAINER (where the repo toolchain lives), then verifies with the repo's own build.
 * Execute-voice counterpart to the old read-only `run_master_review` tool prompt. No writer-subagent mention
 * (Codex has none). Does NOT push — the host commits the edits and ships.
 */
export function renderMasterReviewTask(
  record: DecisionRecord | null,
  repo: ResolvedRepo,
): AgentMessage {
  const decisions = record?.decisions.length
    ? record.decisions
        .map((d) => `- [${d.decisionClass}] ${d.title}: ${d.ruling}`)
        .join('\n')
    : '(none)';
  return agentMessage(
    [
      `Feature overview:\n${record?.overview ?? ''}`,
      `\nLocked decisions (respect these):\n${decisions}`,
      `\nThis is the FINAL review-and-fix pass over the whole feature branch before its pull request opens.`,
      `\n${TASK_LIST_NOTE} Up front, \`task_create\` one task for each step below.`,
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
        ` completion — the review is NOT recorded as done until you call it. This review is ADVISORY: any` +
        ` findings you cannot safely fix yourself go in \`gaps\` (and note them in \`summary\`) for the` +
        ` operator's ship-review — record them and still call \`complete_thread\`.`,
    ].join('\n'),
  );
}
