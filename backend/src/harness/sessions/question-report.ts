import type { WorkerQuestion } from '../engines/worker-engine.port';

/**
 * Rendering for the planning Q&A loop — pure functions, no DI.
 *
 * A plan turn that ends by ASKING (AskUserQuestion captured at the engine seam) reports the
 * questions instead of a plan: `renderQuestionsReport` is that report. The owner answers in free
 * text via reply_session — nothing here is machine-parsed; the engine session interprets the
 * answers natively on resume. Each asked/answered pair is kept on the session (`session.qa`) and
 * `renderQaAppendix` rides it along with the finished plan, so every decision made during planning
 * — Dennis-sourced or self-answered — is visible at approval time.
 */

export interface QaPair {
  /** The serialized questions report of one asking turn (what the owner was shown). */
  q: string;
  /** The owner's reply_session message answering it, verbatim. */
  a: string;
}

const optionLine = (o: WorkerQuestion['options'][number], i: number): string =>
  `  ${i + 1}. ${o.label}${o.description ? ` — ${o.description}` : ''}`;

/** The report of a turn that ended by asking: what relays to the owner and lands in lastReport. */
export function renderQuestionsReport(
  questions: WorkerQuestion[],
  partialPlan?: string,
): string {
  const blocks = questions.map((q, i) => {
    const pick = q.multiSelect ? '(pick one or more)' : '(pick one)';
    const head = q.header ? ` — ${q.header}` : '';
    const title = `**Q${i + 1}${head}${q.options.length ? ` ${pick}` : ''}:** ${q.question}`;
    return q.options.length
      ? `${title}\n${q.options.map(optionLine).join('\n')}`
      : title;
  });
  const plural = questions.length === 1 ? 'question' : 'questions';
  const partial = partialPlan
    ? `\n\n--- Partial plan so far ---\n${partialPlan}`
    : '';
  return `I need answers before I can finish this plan — ${questions.length} ${plural}:

${blocks.join('\n\n')}

Reply into this session with an answer for EVERY question, by number (e.g. "Q1: option 1 — because …"). "Your call" is a valid answer — then I decide.${partial}`;
}

/** The planning Q&A trail appended to a finished plan — what Dennis reads at approval. */
export function renderQaAppendix(qa: QaPair[]): string {
  const rounds = qa.map(
    (pair, i) =>
      `**Asked (round ${i + 1}):**\n${pair.q}\n**Answered:** ${pair.a}`,
  );
  return `### Decisions made while planning (Q&A)

${rounds.join('\n\n')}`;
}
