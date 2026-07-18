'use client';

import { Button } from '@/components/ui/button';
import {
  composerStore,
  useComposerStagedAnswers,
  type StagedAnswer,
} from '@/lib/api/composer-store';
import type { JobRef } from '@/lib/api/job-api';
import { useProvideSecret } from '@/lib/api/job-queries';
import type { WebSecretInputCard } from '@/lib/api/types';
import { CheckCircle2, Clock, ExternalLink, KeyRound, Loader2, XCircle } from 'lucide-react';
import { useState } from 'react';
import { Markdown } from './markdown';
import { cardSendState } from './send-state';

/**
 * A secure secret request the onboarding brain posed via `request_secret`. Renders a MASKED input.
 * Ephemeral requests (`card.ephemeral`) keep the immediate `…/threads/:jobId/provide-secret` POST. Durable
 * and MCP requests instead STAGE the value into the composer's tray — nothing hits the backend until the
 * operator's batched Send — so confirming here just queues it (relabeled "Stage value" to avoid implying
 * it's already stored). The value is never echoed back or kept in the card. Once `provided_at` is set,
 * renders the compact "provided" state.
 */
export function SecretCardView({ card, jobRef }: { card: WebSecretInputCard; jobRef: JobRef }) {
  const provide = useProvideSecret(jobRef);
  const [value, setValue] = useState('');
  const pending = provide.isPending;
  const staged = useComposerStagedAnswers(jobRef).find(
    (a): a is Extract<StagedAnswer, { kind: 'secret' }> =>
      a.kind === 'secret' && a.cardId === card.requestId,
  );

  function submit() {
    if (!value) return;
    if (card.ephemeral) {
      provide.mutate({ requestId: card.requestId, value });
      setValue(''); // never keep the plaintext in component state after sending
      return;
    }
    composerStore.stageAnswer(jobRef, {
      kind: 'secret',
      cardId: card.requestId,
      label: card.path ?? card.mcp?.key ?? card.name,
      value,
    });
    setValue(''); // never keep the plaintext in component state after staging
  }

  if (staged && !staged.submitting) {
    return (
      <div className="anim-pop self-stretch overflow-hidden rounded-lg border border-dashed border-accent-line bg-surface">
        <div className="flex items-center gap-2.5 px-4 py-3">
          <Clock size={15} className="text-accent" />
          <div className="min-w-0 flex-1">
            <p className="text-[13px] font-medium text-text">
              <span className="font-mono">{card.name}</span>
            </p>
            <p className="text-[12.5px] text-dim">•••• staged</p>
            <p className="text-[11px] text-faint">Staged — not yet sent</p>
          </div>
          <button
            type="button"
            onClick={() => composerStore.removeStagedAnswer(jobRef, card.requestId)}
            className="rounded-md px-2 py-1 text-[11.5px] font-medium text-dim hover:text-text"
          >
            Remove
          </button>
        </div>
      </div>
    );
  }

  if (card.withdrawnAt != null && card.provided_at == null) {
    return (
      <div className="anim-pop self-stretch overflow-hidden rounded-lg border border-border bg-surface">
        <div className="flex items-center gap-2.5 px-4 py-3">
          <XCircle size={15} className="text-faint" />
          <div className="min-w-0">
            <p className="truncate text-[12.5px] text-dim line-through">
              <span className="font-mono">{card.name}</span>
            </p>
            <p className="text-[12px] text-faint">
              Withdrawn
              {card.withdrawnReason ? ` — ${card.withdrawnReason}` : ''}
            </p>
          </div>
        </div>
      </div>
    );
  }

  if (
    staged?.submitting ||
    cardSendState(card.provided_at != null, card.delivered_at) === 'sending'
  ) {
    return (
      <div
        className="anim-pop self-stretch overflow-hidden rounded-lg border border-border bg-surface"
        style={{ opacity: 0.7 }}
      >
        <div className="flex items-center gap-2.5 px-4 py-3">
          <Loader2 size={15} className="animate-spin text-faint" />
          <div className="min-w-0">
            <p className="text-[13px] font-medium text-text">
              <span className="font-mono">{card.name}</span>
            </p>
            <p className="text-[12.5px] text-dim">•••• staged</p>
            <p className="mt-0.5 flex items-center gap-1 text-[10px] font-mono text-faint">
              <Loader2 size={9} className="animate-spin" />
              sending…
            </p>
          </div>
        </div>
      </div>
    );
  }

  if (card.provided_at != null) {
    return (
      <div className="anim-pop self-stretch overflow-hidden rounded-lg border border-border bg-surface">
        <div className="flex items-center gap-2.5 px-4 py-3">
          <CheckCircle2 size={15} style={{ color: 'var(--green)' }} />
          <div className="min-w-0">
            <p className="text-[13px] font-medium text-text">
              <span className="font-mono">{card.name}</span> provided
            </p>
            <p className="truncate text-[12.5px] text-dim">
              {card.ephemeral ? (
                'delivered to the session · not stored'
              ) : card.mcp ? (
                <>
                  stored encrypted · MCP server <span className="font-mono">{card.mcp.server}</span>
                </>
              ) : (
                <>
                  stored encrypted · granted to <span className="font-mono">{card.path}</span>
                </>
              )}
            </p>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="anim-pop self-stretch overflow-hidden rounded-lg border border-border bg-surface">
      <div className="flex items-center gap-2.5 border-b border-border px-4 py-3">
        <KeyRound size={15} className="text-accent" />
        <span className="text-[13px] font-semibold text-text">
          Provide secret <span className="font-mono">{card.name}</span>
        </span>
        <div className="flex-1" />
        <span className="rounded-full border border-border px-2 py-0.5 font-mono text-[9.5px] text-dim">
          {card.ephemeral ? 'one-time' : card.mcp ? `mcp:${card.mcp.server}` : card.path}
        </span>
      </div>

      <div className="px-4 py-3">
        <Markdown>{card.description}</Markdown>
        {card.url ? (
          <a
            href={card.url}
            target="_blank"
            rel="noopener noreferrer"
            className="mt-2 inline-flex items-center gap-1.5 text-[12.5px] font-medium text-accent hover:underline"
          >
            <ExternalLink size={13} />
            Open login page
          </a>
        ) : null}
        <p className="mt-1.5 text-[11.5px] leading-snug text-dim">
          {card.ephemeral
            ? 'One-time code — delivered straight to the running session and never stored. It never appears in the conversation or is shown back to Atlas.'
            : 'Sent once, encrypted at rest — it never appears in the conversation or is shown back to Atlas.'}
        </p>
      </div>

      <div className="flex flex-col gap-2 border-t border-border bg-surface-2 px-4 py-3">
        <input
          type="password"
          autoComplete="off"
          value={value}
          onChange={(e) => setValue(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') submit();
          }}
          placeholder={card.url ? 'Paste the code from the login page…' : `Value for ${card.name}…`}
          className="w-full rounded-md border border-border bg-surface px-2.5 py-1.5 font-mono text-[12.5px] text-text outline-none placeholder:text-faint focus:border-accent"
        />
        <div className="flex flex-wrap items-center gap-2">
          <Button
            size="sm"
            loading={Boolean(card.ephemeral) && pending}
            loadingText="Sending…"
            disabled={!value}
            onClick={submit}
          >
            {card.ephemeral ? 'Send code' : 'Stage value'}
          </Button>
          {card.ephemeral && provide.isError ? (
            <span className="text-[11.5px] text-red">
              Could not deliver the code — Atlas will restart the login. Try again.
            </span>
          ) : null}
        </div>
      </div>
    </div>
  );
}
