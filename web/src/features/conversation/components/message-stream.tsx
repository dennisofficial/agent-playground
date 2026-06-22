'use client';

import { useEffect, useRef } from 'react';
import { classifyMessage } from '@/features/conversation/classify';
import { useThreadMessages } from '@/lib/api/messages';
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

/** The conversation stream — the thread's brain. Centered 760px column of typed bubbles. */
export function MessageStream({
  channel,
  threadTs,
  threadKey,
  live,
}: {
  channel: string;
  threadTs: string;
  threadKey: string;
  live: boolean;
}) {
  const { messages, isLoading } = useThreadMessages(channel, threadTs);
  const endRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    endRef.current?.scrollIntoView({ block: 'end' });
  }, [messages.length, live]);

  return (
    <div className="h-full overflow-y-auto">
      <div className="mx-auto flex max-w-[760px] flex-col gap-3.5 px-6 py-6">
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
                return <ApprovalCardView key={message.ts} card={c.card} threadKey={threadKey} />;
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
  );
}
