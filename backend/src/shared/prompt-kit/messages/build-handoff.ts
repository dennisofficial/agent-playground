
import { renderHarnessTag } from '../harness/tag-vocabulary';
import { agentMessage, fromExternal, type AgentMessage } from '../message';

export const HANDOFF_SCHEMA = [
  '1. Scope & files — every file you touched, by path, each with a one-word status: done / WIP / not-started.',
  '2. Failed attempts — every approach that did NOT work, WITH its verbatim error text. Never drop an error:',
  '   the fresh session needs it so it does not walk back into the same dead end.',
  '3. On-disk state NOW — exactly what is committed vs uncommitted WIP in the worktree; name the current commit SHA.',
  '4. Decisions — choices you made this session that are not already written into `/context/specs`.',
  '5. Verification — commands you ran, their exit codes, and the tail of their output (evidence, not claims).',
  '6. Next safe action — the SINGLE concrete next step the fresh session should take. One step, not a plan.',
  '7. Open questions — each with the options you were weighing, so the next session neither re-derives nor re-asks.',
  '8. Pointers — the durable artifacts to re-read (`/context/specs`, the commit SHA). Reference',
  '   them by path; do not re-transcribe them.',
];

export const ROTATION_PREAMBLE = agentMessage(
  renderHarnessTag({
    tag: 'session_rotated',
    body: [
      'Your previous build session filled its context window and was rotated to keep you sharp. Its handoff is below',
      '(also saved verbatim at `/context/generated/handoffs/` if you want to re-read it). Treat it as your OWN',
      'recovered memory. Your work-in-progress from that session is ALREADY ON DISK in this worktree — do NOT restart',
      'the batch, do NOT redo work that is already committed or staged, and do NOT re-ask or re-derive anything the',
      'handoff already settles. Re-read the durable artifacts it points to as needed (`/context/specs`,',
      '`get_pipeline_state`), then continue from its "Next safe action".',
    ].join('\n'),
  }),
);

export const ROTATION_RESUME_TAIL = agentMessage(
  renderHarnessTag({
    tag: 'resume_here',
    body: [
      'You are RESUMING a rotated session. Your recovered handoff and carried checklist are at the TOP of this message;',
      'the thread brief and batch above are unchanged context, NOT a signal to start over. Before anything else:',
      '1. Re-read your OWN thread spec section under `/context/specs/sections/` and the specific pointers your handoff',
      '   names (the commit SHA, the files by path). Do NOT re-read every spec — pull only what this next step needs.',
      '2. Do the SINGLE "Next safe action" from your handoff. One step, then reassess against the carried checklist.',
      '3. Continue — do NOT restart the batch, do NOT redo work already committed or staged, and do NOT re-ask or',
      '   re-derive anything the handoff already settles.',
    ].join('\n'),
  }),
);

export const ROTATION_SOFT_NUDGE = agentMessage(
  renderHarnessTag({
    tag: 'context_pressure',
    attrs: [['phase', 'soft']],
    body: [
      'Your context window is filling up. This is a system signal based on your ACTUAL live token usage — trust it',
      'even if it feels early. Get to a safe stopping point: finish only the step you are on and, if you are at a',
      'natural boundary, commit it. Do NOT start new large work.',
      '',
      'Then call `record_leg_handoff` with ONE `handoff` markdown string so a FRESH session can continue with zero',
      'loss. A good handoff is concrete — real paths, verbatim errors, one next step — under these headings:',
      '',
      ...HANDOFF_SCHEMA,
      '',
      'Write what a fresh session could NOT recover just by reading the tree. Omit a heading rather than pad it. After',
      'you call the tool, STOP and yield — your work-in-progress is safe on disk and the next session picks it up.',
    ].join('\n'),
  }),
);

export const ROTATION_REMINDER_NUDGE = agentMessage(
  renderHarnessTag({
    tag: 'context_pressure',
    attrs: [['phase', 'reminder']],
    body: [
      'You still owe a handoff and your context has grown further since the last signal — recall and reasoning are',
      'degrading. Nothing will force this for you: rotation happens ONLY when you call `record_leg_handoff`. Get to a',
      'safe stopping point NOW, then call `record_leg_handoff` with the structured handoff described earlier (scope &',
      'files by status; FAILED attempts with verbatim errors; committed-vs-WIP on-disk state + commit SHA; the single',
      'next safe action; open questions with options; pointers). Then yield. Do not start anything new.',
    ].join('\n'),
  }),
);

export const RECORD_LEG_HANDOFF_DESCRIPTION =
  'Hand off this build session to a fresh one when your context is full (you were nudged about context pressure). ' +
  'Pass a single `handoff` markdown string covering: scope & files changed by path+status; FAILED attempts WITH ' +
  'their verbatim errors; committed-vs-WIP on-disk state + commit SHA; decisions this session; verification ' +
  '(commands + exit codes + output tails); the single next safe action; open questions with options; and pointers ' +
  '(`/context/specs`). After calling this, STOP and yield — your WIP is on disk.';

export function composeLegSeed(handoff: string, carriedTasks: AgentMessage): AgentMessage {
  return agentMessage(
    [ROTATION_PREAMBLE, fromExternal(handoff), ...(carriedTasks ? [carriedTasks] : [])].join(
      '\n\n',
    ),
  );
}

export function foldLegSeed(seed: AgentMessage | null, baseTask: AgentMessage): AgentMessage {
  return agentMessage(
    seed ? `${seed}\n\n---\n\n${baseTask}\n\n---\n\n${ROTATION_RESUME_TAIL}` : baseTask,
  );
}

export function foldLegTurn(
  seed: string | null,
  baseTask: AgentMessage,
  servicesBlock: string,
): AgentMessage {
  const withServices = agentMessage(servicesBlock ? `${baseTask}\n\n${servicesBlock}` : baseTask);
  return foldLegSeed(seed != null ? fromExternal(seed) : null, withServices);
}

export function stripContextPressureTag(nudge: AgentMessage): AgentMessage {
  const stripped = nudge
    .replace(/^<context_pressure[^>]*>\s*/, '')
    .replace(/\s*<\/context_pressure>\s*$/, '')
    .trim();
  return agentMessage(stripped);
}

export const RECORD_LEG_HANDOFF_STOP =
  'Handoff recorded and saved to /context/generated/handoffs/. Your session will now rotate: a fresh session ' +
  'continues from this handoff with your work-in-progress intact on disk. STOP here and end your turn now — do ' +
  'not take any further action.';
