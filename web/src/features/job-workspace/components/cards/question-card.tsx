'use client';

import { Button } from '@/components/ui/button';
import { ShortcutHint } from '@/components/ui/shortcut-hint';
import {
  composerStore,
  useComposerStagedAnswers,
  type StagedAnswer,
} from '@/lib/api/composer-store';
import type { JobRef } from '@/lib/api/job-api';
import { useMessage } from '@/lib/api/job-queries';
import type { WebQuestionCard } from '@/lib/api/types';
import { isSubmitCombo } from '@/utils/keyboard';
import { CheckCircle2, Clock, HelpCircle, Loader2, XCircle } from 'lucide-react';
import { useState } from 'react';
import { cardSendState } from '../../lib/send-state';
import { Markdown } from '../conversation/markdown';

/**
 * A formal question the brain posed via `ask_question`. Renders one button per option (+ optional
 * free-text "Other"). A `build`-origin question (the driver's onboarding/build-flow asks) still POSTs
 * immediately (an `answer_question` message on its own); every other question STAGES the pick into the
 * composer's tray instead — nothing hits the backend until the operator's batched Send. Once
 * `card.answer` is set, renders the compact answered state (so a reload still shows what was asked +
 * chosen); that fires either immediately (build-origin) or after the batch send settles.
 */
export function QuestionCardView({ card, jobRef }: { card: WebQuestionCard; jobRef: JobRef }) {
  const answer = useMessage(jobRef);
  const [other, setOther] = useState('');
  const [showOther, setShowOther] = useState(false);
  const pending = answer.isPending;
  const staged = useComposerStagedAnswers(jobRef).find(
    (a): a is Extract<StagedAnswer, { kind: 'question' }> =>
      a.kind === 'question' && a.cardId === card.questionId,
  );

  function submit(text: string) {
    const trimmed = text.trim();
    if (!trimmed) return;
    if (card.origin === 'build') {
      answer.mutate({
        messages: [
          {
            type: 'answer_question',
            questionId: card.questionId,
            answer: trimmed,
          },
        ],
      });
      return;
    }
    composerStore.stageAnswer(jobRef, {
      kind: 'question',
      cardId: card.questionId,
      label: card.question,
      answer: trimmed,
    });
  }

  if (staged && !staged.submitting) {
    return (
      <div className="anim-pop self-stretch overflow-hidden rounded-lg border border-dashed border-accent-line bg-surface">
        <div className="flex items-center gap-2.5 px-4 py-3">
          <Clock size={15} className="text-accent" />
          <div className="min-w-0 flex-1">
            <p className="truncate text-[12.5px] text-dim">{card.question}</p>
            <p className="text-[13px] font-medium text-text">{staged.answer}</p>
            <p className="text-[11px] text-faint">Staged — not yet sent</p>
          </div>
          <button
            type="button"
            onClick={() => composerStore.removeStagedAnswer(jobRef, card.questionId)}
            className="rounded-md px-2 py-1 text-[11.5px] font-medium text-dim hover:text-text"
          >
            Remove
          </button>
        </div>
      </div>
    );
  }

  if (card.withdrawnAt != null && card.answer == null) {
    return (
      <div className="anim-pop self-stretch overflow-hidden rounded-lg border border-border bg-surface">
        <div className="flex items-center gap-2.5 px-4 py-3">
          <XCircle size={15} className="text-faint" />
          <div className="min-w-0">
            <p className="truncate text-[12.5px] text-dim line-through">{card.question}</p>
            <p className="text-[12px] text-faint">
              Withdrawn
              {card.withdrawnReason ? ` — ${card.withdrawnReason}` : ''}
            </p>
          </div>
        </div>
      </div>
    );
  }

  if (staged?.submitting || cardSendState(card.answer != null, card.deliveredAt) === 'sending') {
    return (
      <div
        className="anim-pop self-stretch overflow-hidden rounded-lg border border-border bg-surface"
        style={{ opacity: 0.7 }}
      >
        <div className="flex items-center gap-2.5 px-4 py-3">
          <Loader2 size={15} className="animate-spin text-faint" />
          <div className="min-w-0">
            <p className="truncate text-[12.5px] text-dim">{card.question}</p>
            <p className="text-[13px] font-medium text-text">{card.answer ?? staged?.answer}</p>
            <p className="mt-0.5 flex items-center gap-1 text-[10px] font-mono text-faint">
              <Loader2 size={9} className="animate-spin" />
              sending…
            </p>
          </div>
        </div>
      </div>
    );
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
        <Markdown>{card.question}</Markdown>
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
              <span className="mt-0.5 block text-[11.5px] leading-snug text-dim">
                {opt.description}
              </span>
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
              onKeyDown={(e) => {
                // ⌘/Ctrl+Enter sends the answer; plain Enter still inserts a newline.
                if (!isSubmitCombo(e)) return;
                e.preventDefault();
                if (pending) return;
                submit(other);
              }}
              placeholder="Type your answer…"
              rows={2}
              className="w-full resize-y rounded-md border border-border bg-surface px-2.5 py-1.5 text-[12.5px] text-text outline-none placeholder:text-faint focus:border-accent"
            />
            <div className="flex flex-wrap gap-2">
              <Button
                size="sm"
                loading={pending}
                loadingText="Sending…"
                onClick={() => submit(other)}
              >
                Send answer
                <ShortcutHint />
              </Button>
              <Button
                size="sm"
                variant="ghost"
                disabled={pending}
                onClick={() => setShowOther(false)}
              >
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
