'use client';

import Link from 'next/link';
import { useSelectedLayoutSegment } from 'next/navigation';
import { FileText, GitBranch, Lock, MessageSquare } from 'lucide-react';
import { cn } from '@/lib/cn';
import { ROUTES } from '@/lib/routes';
import { Dot, KindBadge, StatusPill } from '@/components/ui/badges';
import { sectionColor } from '@/lib/api/status';
import { usePipelineOutline } from '@/lib/api/pipeline';
import { useThreadMessages } from '@/lib/api/messages';
import type { ThreadKind } from '@/lib/api/types';

function deriveTitle(text: string | undefined): string {
  const line = (text ?? 'Thread').trim().split('\n')[0].trim();
  return line.length > 60 ? `${line.slice(0, 59)}…` : line || 'Thread';
}

/** The thread navigator (288px) — state-driven outline. DERIVED from the stream (see BACKEND_GAPS). */
export function Navigator({
  threadKey,
  channel,
  threadTs,
}: {
  threadKey: string;
  channel: string;
  threadTs: string;
}) {
  const segment = useSelectedLayoutSegment(); // null = conversation, 'plan', 'doc', 'phase'
  const { messages } = useThreadMessages(channel, threadTs);
  const outline = usePipelineOutline(channel, threadTs);

  const title = deriveTitle(messages[0]?.text);
  const kind: ThreadKind = outline.gated || outline.sections.length ? 'feat' : 'feat';

  return (
    <nav className="flex w-72 shrink-0 flex-col overflow-y-auto border-r border-border bg-panel">
      <div className="border-b border-border px-4 py-3.5">
        <div className="flex items-center gap-2">
          <KindBadge kind={kind} />
          <StatusPill status={outline.status} />
        </div>
        <h2 className="mt-2 font-disp text-[16px] font-semibold leading-snug text-text">{title}</h2>
        <div className="mt-1.5 flex items-center gap-1.5 font-mono text-[10px] text-faint">
          <GitBranch size={11} />
          <span className="truncate">{outline.prUrl ? 'feature branch · PR open' : 'feature branch'}</span>
        </div>
      </div>

      <div className="flex flex-col gap-0.5 p-2">
        <NavNode href={ROUTES.thread(threadKey)} active={segment === null} icon={<MessageSquare size={14} />}>
          Conversation
        </NavNode>
      </div>

      <Group label="Context">
        <NavNode href={ROUTES.threadPlan(threadKey)} active={segment === 'plan'} icon={<FileText size={14} />}>
          plan.md
        </NavNode>
        <NavNode
          href={ROUTES.threadDoc(threadKey, 'decision-record')}
          active={segment === 'doc'}
          icon={<Lock size={13} />}
        >
          decision-record.md
        </NavNode>
      </Group>

      {outline.sections.length > 0 ? (
        <Group label={outline.gated ? 'Proposed · for review' : 'Pipeline'}>
          {outline.sections.map((s) => {
            const sc = sectionColor(s.active ? 'executing' : 'pending');
            return (
              <Link
                key={s.ordinal}
                href={ROUTES.threadPhase(threadKey, `s${s.ordinal}`)}
                className={cn(
                  'flex items-start gap-2 rounded-md px-2.5 py-2 text-[12.5px] transition hover:bg-surface-2',
                  segment === 'phase' ? 'text-text' : 'text-dim',
                )}
              >
                <span className="mt-1">
                  <Dot color={sc.color} pulse={s.active} size={7} />
                </span>
                <span className="flex-1">
                  <span className="font-mono text-[9.5px] text-faint">§{s.ordinal}</span>{' '}
                  <span className="text-text">{s.brief}</span>
                  {s.active ? (
                    <span className="mt-1.5 block h-1 overflow-hidden rounded-full" style={{ background: 'var(--surface-3)' }}>
                      <span
                        className="prog-sweep block h-full w-1/2 rounded-full"
                        style={{ background: 'var(--accent)' }}
                      />
                    </span>
                  ) : null}
                </span>
              </Link>
            );
          })}
        </Group>
      ) : (
        <Group label={outline.status === 'scoping' ? 'Planning — in the conversation' : 'Pipeline'}>
          <p className="px-2.5 py-2 text-[11.5px] text-faint">
            No pipeline yet. Sections form as Atlas plans in the conversation.
          </p>
        </Group>
      )}

      {outline.prUrl ? (
        <Group label="Artifacts">
          <a
            href={outline.prUrl}
            target="_blank"
            rel="noreferrer"
            className="block rounded-md px-2.5 py-2 text-[12.5px] text-accent hover:bg-surface-2"
          >
            Pull request ↗
          </a>
        </Group>
      ) : null}

      <p className="mt-auto px-4 py-3 font-mono text-[9px] leading-relaxed text-faint">
        Outline derived from the live stream. Authoritative section status needs /web/threads.
      </p>
    </nav>
  );
}

function Group({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="px-2 pb-1 pt-2">
      <p className="px-1.5 pb-1 font-mono text-[9px] uppercase tracking-[0.16em] text-faint">{label}</p>
      <div className="flex flex-col gap-0.5">{children}</div>
    </div>
  );
}

function NavNode({
  href,
  active,
  icon,
  children,
}: {
  href: string;
  active: boolean;
  icon: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <Link
      href={href}
      className={cn(
        'flex items-center gap-2 rounded-md px-2.5 py-2 text-[12.5px] transition',
        active ? 'text-text' : 'text-dim hover:bg-surface-2',
      )}
      style={active ? { background: 'var(--accent-soft)' } : undefined}
    >
      <span className="text-faint">{icon}</span>
      {children}
    </Link>
  );
}
