'use client';

import { useState } from 'react';
import { CheckCircle2, HelpCircle } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { useAnswerQuestion } from '@/lib/api/thread-queries';
import type { JobRef } from '@/lib/api/thread-api';
import type { WebQuestionCard } from '@/lib/api/types';

const ANSWERED_BY = 'U-OPERATOR';

/**
 * A formal question the brain posed via `ask_question`. Renders one button per option (+ optional
 * free-text "Other"); the pick POSTs to `…/threads/:jobId/answer-question`, which stamps the durable
 * answered state and fires the brain's next turn. Once `card.answer` is set, renders the compact
 * answered state (so a reload still shows what was asked + chosen).
 */
export function QuestionCardView({ card, threadRef }: { card: WebQuestionCard; threadRef: JobRef }) {
  const answer = useAnswerQuestion(threadRef);
  const [other, setOther] = useState('');
  const [showOther, setShowOther] = useState(false);
  const pending = answer.isPending;

  function submit(text: string) {
    const trimmed = text.trim();
    if (!trimmed) return;
    answer.mutate({ questionId: card.questionId, answer: trimmed, answeredBy: ANSWERED_BY });
  }

  if (card.answer != null) {
    return (
      <div className="anim-pop self-stretch overflow-hidden rounded-lg border border-border bg-surface">
        <div className="flex items-center gap-2.5 px-4 py-3">
          <CheckCircle2 size={15} style={{ color: 'var(--green)' }} />
          <div className="min-w-0">
            <p className="truncate text-[12.5px] text-dim">{card.question}</p>
            <p className="text-[13px] font-medium text-text">{card.answer}</p>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="anim-pop self-stretch overflow-hidden rounded-lg border border-border bg-surface">
      <div className="flex items-center gap-2.5 border-b border-border px-4 py-3">
        <HelpCircle size={15} className="text-accent" />
        <span className="text-[13px] font-semibold text-text">{card.header ?? 'Question'}</span>
        <div className="flex-1" />
        {card.decisionClass ? (
          <span className="rounded-full border border-border px-2 py-0.5 font-mono text-[9.5px] text-dim">
            {card.decisionClass}
          </span>
        ) : null}
      </div>

      <div className="px-4 py-3">
        <p className="whitespace-pre-wrap text-[13px] leading-relaxed text-text">{card.question}</p>
      </div>

      <div className="flex flex-col gap-1.5 border-t border-border bg-surface-2 px-4 py-3">
        {card.options.map((opt) => (
          <button
            key={opt.id}
            type="button"
            disabled={pending}
            onClick={() => submit(opt.label)}
            className="rounded-md border border-border bg-surface px-3 py-2 text-left hover:border-accent disabled:opacity-60"
          >
            <span className="text-[12.5px] font-medium text-text">{opt.label}</span>
            {opt.description ? (
              <span className="mt-0.5 block text-[11.5px] leading-snug text-dim">{opt.description}</span>
            ) : null}
          </button>
        ))}

        {card.allowOther && !showOther ? (
          <button
            type="button"
            disabled={pending}
            onClick={() => setShowOther(true)}
            className="self-start text-[11.5px] font-medium text-accent hover:underline disabled:opacity-60"
          >
            Other…
          </button>
        ) : null}

        {card.allowOther && showOther ? (
          <div className="flex flex-col gap-2">
            <textarea
              autoFocus
              value={other}
              onChange={(e) => setOther(e.target.value)}
              placeholder="Type your answer…"
              rows={2}
              className="w-full resize-y rounded-md border border-border bg-surface px-2.5 py-1.5 text-[12.5px] text-text outline-none placeholder:text-faint focus:border-accent"
            />
            <div className="flex flex-wrap gap-2">
              <Button size="sm" loading={pending} loadingText="Sending…" onClick={() => submit(other)}>
                Send answer
              </Button>
              <Button size="sm" variant="ghost" disabled={pending} onClick={() => setShowOther(false)}>
                Cancel
              </Button>
            </div>
          </div>
        ) : null}

        {answer.isError ? (
          <p className="text-[11.5px] text-red">Could not submit your answer. Try again.</p>
        ) : null}
      </div>
    </div>
  );
}
