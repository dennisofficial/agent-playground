'use client';

import { useState } from 'react';
import { CheckCircle2, ExternalLink, KeyRound } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { useProvideSecret } from '@/lib/api/job-queries';
import type { JobRef } from '@/lib/api/job-api';
import type { WebSecretInputCard } from '@/lib/api/types';

/**
 * A secure secret request the onboarding brain posed via `request_secret`. Renders a MASKED input; the
 * value POSTs to `…/threads/:jobId/provide-secret`, which stores it encrypted + grants it. The value is
 * never echoed back or kept in the card. Once `provided_at` is set, renders the compact "provided" state.
 */
export function SecretCardView({ card, jobRef }: { card: WebSecretInputCard; jobRef: JobRef }) {
  const provide = useProvideSecret(jobRef);
  const [value, setValue] = useState('');
  const pending = provide.isPending;

  function submit() {
    if (!value) return;
    provide.mutate({ requestId: card.requestId, value });
    setValue(''); // never keep the plaintext in component state after sending
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
          {card.ephemeral ? 'one-time' : card.path}
        </span>
      </div>

      <div className="px-4 py-3">
        <p className="whitespace-pre-wrap text-[13px] leading-relaxed text-text">{card.description}</p>
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
            loading={pending}
            loadingText={card.ephemeral ? 'Sending…' : 'Storing…'}
            disabled={!value}
            onClick={submit}
          >
            {card.ephemeral ? 'Send code' : 'Store securely'}
          </Button>
          {provide.isError ? (
            <span className="text-[11.5px] text-red">
              {card.ephemeral
                ? 'Could not deliver the code — Atlas will restart the login. Try again.'
                : 'Could not store the secret. Try again.'}
            </span>
          ) : null}
        </div>
      </div>
    </div>
  );
}
