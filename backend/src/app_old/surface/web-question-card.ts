
import type { DecisionClass } from '../../_shared/domain/decision-record';

export interface WebQuestionOption {
  id: string;
  label: string;
  description?: string;
}

export interface WebQuestionCard {
  type: 'question_card';
  origin?: 'brain' | 'build';
  jobId: string;
  questionId: string;
  header?: string;
  question: string;
  decisionClass?: DecisionClass;
  options: WebQuestionOption[];
  allowOther: boolean;
  answer?: string;
  answeredAt?: string;
  deliveredAt?: string;
  loggedDecision?: boolean;
  withdrawnAt?: string;
  withdrawnReason?: string;
}

export function nextQuestionId(existingIds: readonly string[]): string {
  const max = existingIds.reduce((m, id) => {
    const match = /^q(\d+)$/.exec(id);
    return match ? Math.max(m, Number(match[1])) : m;
  }, 0);
  return `q${max + 1}`;
}

function slug(label: string): string {
  return (
    label
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 48) || 'opt'
  );
}

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
