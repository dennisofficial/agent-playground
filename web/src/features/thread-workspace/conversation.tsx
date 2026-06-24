'use client';

import { useEffect, useRef } from 'react';
import { classifyMessage } from './classify';
import {
  ClaudeBubble,
  DecisionChip,
  LiveIndicator,
  ParkAndAsk,
  PrCard,
  SystemEventPill,
  UserBubble,
} from './bubbles';
import { ApprovalCardView, VerdictCardView } from './approval-card';
import { Composer } from './composer';
import type { ThreadMessage, ThreadRef } from '@/lib/api/thread-api';

/**
 * Conversation mode — the thread's brain. One continuous session: intent, planning, and steering all
 * live here. A centered 760px column of typed bubbles + the composer.
 */
export function Conversation({
  threadRef,
  messages,
  isLoading,
  live,
  branch,
  onOpenPlan,
}: {
  threadRef: ThreadRef;
  messages: ThreadMessage[];
  isLoading: boolean;
  live: boolean;
  branch?: string;
  onOpenPlan?: () => void;
}) {
  const endRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    endRef.current?.scrollIntoView({ block: 'end' });
  }, [messages.length, live]);

  return (
    <div className="flex h-full min-h-0 flex-col bg-surface">
      <div className="min-h-0 flex-1 overflow-y-auto px-6 py-6">
        <div className="mx-auto flex max-w-[760px] flex-col gap-3.5">
          <div className="self-center pb-1 text-center font-mono text-[9.5px] leading-relaxed tracking-[0.04em] text-faint">
            one continuous session{branch ? ` · ${branch}` : ''}
            <br />
            this is the thread&apos;s brain — intent, planning, and steering all live here
          </div>

          {isLoading && messages.length === 0 ? (
            <p className="py-10 text-center text-[13px] text-faint">Loading conversation…</p>
          ) : messages.length === 0 ? (
            <p className="py-10 text-center text-[13px] text-faint">
              No messages yet — say something to Atlas below.
            </p>
          ) : (
            messages.map((message) => {
              const c = classifyMessage(message);
              switch (c.kind) {
                case 'user':
                  return <UserBubble key={message.ts} message={message} />;
                case 'approval':
                  return (
                    <ApprovalCardView key={message.ts} card={c.card} threadRef={threadRef} onOpenPlan={onOpenPlan} />
                  );
                case 'verdict':
                  return <VerdictCardView key={message.ts} card={c.card} />;
                case 'decision':
                  return <DecisionChip key={message.ts} message={message} />;
                case 'park':
                  return <ParkAndAsk key={message.ts} message={message} />;
                case 'pr':
                  return <PrCard key={message.ts} message={message} />;
                case 'event':
                  return <SystemEventPill key={message.ts} message={message} tone={c.tone} />;
                case 'claude':
                default:
                  return <ClaudeBubble key={message.ts} message={message} />;
              }
            })
          )}
          {live ? <LiveIndicator /> : null}
          <div ref={endRef} />
        </div>
      </div>

      <Composer
        threadRef={threadRef}
        hint={'talking to the thread’s Claude session · "pause", "simplify the rest" run the same ops as the buttons'}
      />
    </div>
  );
}
