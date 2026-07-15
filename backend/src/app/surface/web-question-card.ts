/**
 * Web QUESTION card payload — the structured, multiple-choice question the thread brain poses to the
 * operator via the `ask_question` tool (instead of asking in prose). The web client renders it like a
 * native "ask user question": a header + question + one button per option (+ an optional free-text
 * "Other"). The operator's pick is POSTed back to `…/threads/:jobId/answer-question`, which both
 * stamps the durable answered state onto this card and injects the answer as a normal reply (firing the
 * next brain turn). When `answer` is set, the client renders the compact answered state.
 *
 * Pure — no I/O, no NestJS. Zero v1 imports.
 */

import type { DecisionClass } from '../domain/decision-record';

/** One selectable answer in a question card. */
export interface WebQuestionOption {
  /** Stable id (also POSTed back); defaults to the slugged label when the brain omits it. */
  id: string;
  label: string;
  description?: string;
}

/** A rendered web question card — posted to the surface transcript + persisted as a durable card row. */
export interface WebQuestionCard {
  /** Discriminant — the web client checks `type` to decide which component to render. */
  type: 'question_card';
  /**
   * Who posed the question and therefore who consumes the answer. `'brain'` (default/undefined) → the
   * `answer-question` endpoint seeds a delivery turn to the brain. `'build'` → the orchestrate build
   * turn's `request_operator_input`; the endpoint stamps the answer but does NOT seed a brain turn (the
   * driver polls this card for the answer instead). Keeps the two consumers off each other's spine.
   */
  origin?: 'brain' | 'build';
  jobId: string;
  /**
   * Stable key for this question (the card row's `ts`); the answer POST echoes it back. For the
   * conversational brain's `ask_question` this is the short sequential form `q1`, `q2`, … (see
   * {@link nextQuestionId}) — short enough for Atlas to reference back in `withdraw_question` /
   * `create_decision({ questionId })`. The driver's build-origin cards use an opaque uuid instead.
   */
  questionId: string;
  header?: string;
  question: string;
  /** The always-ask class this question is about, when it maps to one (drives a small badge + the log). */
  decisionClass?: DecisionClass;
  options: WebQuestionOption[];
  /** Whether the operator may answer with free text instead of an option. */
  allowOther: boolean;
  /** Set once answered — the durable answered state (renders the compact "answered" card on reload). */
  answer?: string;
  /** ISO-8601 answer time. */
  answeredAt?: string;
  /**
   * ISO-8601 time the answer was DELIVERED to the brain (a delivery turn actually ran). The durable
   * lifecycle is `asked → answered (answer/answeredAt) → delivered (deliveredAt) → loggedDecision`.
   * Stamped only after a successful turn consumes the answer, so the boot reconciliation sweep can
   * re-deliver any `answer != null && deliveredAt == null` card a crash left stranded (at-least-once).
   */
  deliveredAt?: string;
  /** Set true once a `create_decision` has consumed this Q&A, so the same answer can't attach twice. */
  loggedDecision?: boolean;
  /**
   * ISO-8601 time the brain RETRACTED this still-unanswered question via `withdraw_question` — e.g. to
   * reword it, or because a later answer/turn made it moot. A withdrawn card is terminal (like answered):
   * it no longer counts toward the open-question gate, is not re-surfaced to the brain, and the web renders
   * it as a compact "withdrawn" state (the answer buttons disappear).
   */
  withdrawnAt?: string;
  /** Optional operator-visible note on WHY the brain withdrew the question. */
  withdrawnReason?: string;
}

/**
 * Allocate the next stable brain question id: `q<max+1>` over the existing `q<n>` ids (`q1` when none),
 * mirroring `nextDecisionId`'s `d<n>` scheme. Max-based so an id is NEVER reused after a withdrawal — a
 * withdrawn id must not resurface and re-point a stale reference. Ignores ids that aren't `q<n>` (e.g. the
 * driver's build-origin uuid cards), so the brain's ids stay a clean `q1, q2, …` sequence.
 */
export function nextQuestionId(existingIds: readonly string[]): string {
  const max = existingIds.reduce((m, id) => {
    const match = /^q(\d+)$/.exec(id);
    return match ? Math.max(m, Number(match[1])) : m;
  }, 0);
  return `q${max + 1}`;
}

/** Lowercase-kebab a label into a stable option id. */
function slug(label: string): string {
  return (
    label
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 48) || 'opt'
  );
}

/** Build a `WebQuestionCard` from the brain's `ask_question` args (options normalized + id-filled). */
export function webQuestionCard(input: {
  jobId: string;
  questionId: string;
  question: string;
  header?: string;
  decisionClass?: DecisionClass;
  options: { id?: string; label: string; description?: string }[];
  allowOther: boolean;
}): WebQuestionCard {
  const seen = new Set<string>();
  const options: WebQuestionOption[] = input.options.map((o, i) => {
    let id = o.id?.trim() || slug(o.label);
    while (seen.has(id)) id = `${id}-${i}`;
    seen.add(id);
    return {
      id,
      label: o.label,
      ...(o.description ? { description: o.description } : {}),
    };
  });
  return {
    type: 'question_card',
    jobId: input.jobId,
    questionId: input.questionId,
    ...(input.header ? { header: input.header } : {}),
    question: input.question,
    ...(input.decisionClass ? { decisionClass: input.decisionClass } : {}),
    options,
    allowOther: input.allowOther,
  };
}
