'use client';

import { useState } from 'react';
import { ArrowLeft, Info } from 'lucide-react';
import { cn } from '@/lib/cn';
import { useSay } from '@/lib/api/thread-queries';
import { sectionTitle } from '@/lib/section-brief';
import { VerdictButtons } from './approval-card';
import { pipelineJob, type ThreadMessage, type ThreadRef } from '@/lib/api/thread-api';
import {
  APPROVE_ACTION_ID,
  type PipelineState,
  type WebApprovalCard,
} from '@/lib/api/types';

type PhaseTab = 'transcript' | 'diff' | 'logs';

/**
 * Phase mode — the work column when a navigator node is selected. The plan / decision docs and the build
 * transcript/diff/logs render REAL data where the web API exposes it (the approved plan card's decisions +
 * sections; the thread's `build_event` relays) and clearly-labeled PLACEHOLDERS where it doesn't (no
 * per-phase transcript/diff/logs endpoint, no plan.md/decision-record content endpoint — see
 * `web/BACKEND_GAPS.md`).
 */
export function PhaseView({
  threadRef,
  pipeline,
  messages,
  approvalCard,
  selectedNode,
  onConversation,
}: {
  threadRef: ThreadRef;
  pipeline: PipelineState | undefined;
  messages: ThreadMessage[];
  approvalCard: WebApprovalCard | null;
  selectedNode: string;
  onConversation: () => void;
}) {
  const job = pipelineJob(pipeline);
  const section = job?.sections.find((s) => s.id === selectedNode) ?? null;

  let body: React.ReactNode;
  if (selectedNode === 'plan') {
    body = <PlanDoc card={approvalCard} title={job?.title} sections={job?.sections.map((s) => s.brief)} threadRef={threadRef} />;
  } else if (selectedNode === 'decision') {
    body = <DecisionDoc card={approvalCard} />;
  } else if (selectedNode.startsWith('secplan:')) {
    const id = selectedNode.slice('secplan:'.length);
    const sec = job?.sections.find((s) => s.id === id) ?? null;
    body = <SectionPlanDoc brief={sec ? sectionTitle(sec.brief) : 'Section plan'} />;
  } else if (selectedNode.startsWith('autofix:')) {
    body = <AutoFixView />;
  } else if (section) {
    body = <BuildView threadRef={threadRef} label={`§ ${sectionTitle(section.brief)}`} messages={messages} />;
  } else {
    body = <BuildView threadRef={threadRef} label="Build" messages={messages} />;
  }

  return (
    <div className="flex h-full min-h-0 flex-col bg-surface">
      <div className="flex shrink-0 items-center gap-3 border-b border-border px-5 py-3">
        <button
          type="button"
          onClick={onConversation}
          className="inline-flex items-center gap-1.5 font-mono text-[10.5px] text-dim hover:text-text"
        >
          <ArrowLeft size={12} /> Conversation
        </button>
      </div>
      <div className="min-h-0 flex-1 overflow-hidden">{body}</div>
    </div>
  );
}

// ── Build phase (transcript / diff / logs) ───────────────────────────────────────────────────────
function BuildView({
  threadRef,
  label,
  messages,
}: {
  threadRef: ThreadRef;
  label: string;
  messages: ThreadMessage[];
}) {
  const [tab, setTab] = useState<PhaseTab>('transcript');
  const buildEvents = messages.filter((m) => m.kind === 'build_event').map((m) => m.text);

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="shrink-0 px-5 pt-3">
        <div className="mb-2.5 flex items-center gap-2.5">
          <span className="font-mono text-[12px] font-semibold">{label}</span>
          <span
            className="inline-flex items-center gap-1.5 rounded-sm border px-2 py-0.5 text-[10px] text-accent"
            style={{ background: 'var(--accent-soft)', borderColor: 'var(--accent-line)' }}
          >
            Claude · execute
          </span>
        </div>
        <div className="flex gap-5 text-[12px] font-semibold">
          {(['transcript', 'diff', 'logs'] as PhaseTab[]).map((t) => (
            <button
              key={t}
              type="button"
              onClick={() => setTab(t)}
              className={cn('-mb-px border-b-2 pb-2.5 capitalize', tab === t ? 'border-accent text-accent' : 'border-transparent text-faint')}
            >
              {t}
            </button>
          ))}
        </div>
        <div className="h-px w-full" style={{ background: 'var(--border)' }} />
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto px-5 py-4">
        {tab === 'transcript' ? (
          <Transcript lines={buildEvents} />
        ) : (
          <Placeholder
            title={tab === 'diff' ? 'Diff' : 'Logs'}
            body={`The per-phase ${tab} stream isn't exposed by the web surface yet. It will render here once the backend adds a phase read endpoint.`}
          />
        )}
      </div>

      <InterjectBar threadRef={threadRef} />
    </div>
  );
}

function Transcript({ lines }: { lines: string[] }) {
  return (
    <div className="flex max-w-[780px] flex-col gap-2 font-mono text-[12px]">
      <Banner text="Showing live build-event relays from the thread (per-phase transcript pending a backend endpoint)." />
      {lines.length === 0 ? (
        <p className="text-faint">No build activity relayed yet.</p>
      ) : (
        lines.map((line, i) => (
          <div key={i} className="rounded-md border border-border bg-surface-2 px-3 py-2 text-dim">
            {line}
          </div>
        ))
      )}
      <span className="cursor-blink inline-block h-3.5 w-1.5" style={{ background: 'var(--accent)' }} aria-hidden />
    </div>
  );
}

/** Talks to the build session (via the thread). Pause / Revert are UI-only (no backend op route). */
function InterjectBar({ threadRef }: { threadRef: ThreadRef }) {
  const say = useSay(threadRef);
  const [text, setText] = useState('');
  const [queued, setQueued] = useState<string[]>([]);

  function send() {
    const trimmed = text.trim();
    if (!trimmed) return;
    say.mutate(trimmed);
    setQueued((q) => [...q, trimmed]);
    setText('');
  }

  return (
    <div
      className="shrink-0 border-t border-border px-5 py-3"
      style={{ background: 'color-mix(in srgb, var(--panel) 40%, transparent)' }}
    >
      {queued.length > 0 ? (
        <div className="mb-2 flex flex-wrap gap-1.5">
          {queued.map((q, i) => (
            <span
              key={i}
              className="inline-flex items-center gap-1.5 rounded-full border px-2.5 py-0.5 font-mono text-[10px] text-accent"
              style={{ background: 'var(--accent-soft)', borderColor: 'var(--accent-line)' }}
            >
              ⏳ {q.length > 40 ? `${q.slice(0, 39)}…` : q} <span className="text-faint">· folds next turn</span>
            </span>
          ))}
        </div>
      ) : null}
      <div className="mb-2 flex items-center gap-2">
        <button type="button" disabled className="rounded-md border border-border-2 px-3 py-1.5 text-[11px] text-dim opacity-60" title="Needs a backend pause route">
          ⏸ Pause
        </button>
        <button type="button" disabled className="rounded-md border border-border-2 px-3 py-1.5 text-[11px] text-dim opacity-60" title="Needs a backend revert route">
          ↩ Revert phase
        </button>
      </div>
      <div
        className="flex items-center gap-2.5 rounded-lg border px-3 py-2"
        style={{ borderColor: 'var(--accent-line)', background: 'var(--surface-2)', boxShadow: '0 0 0 4px var(--accent-soft)' }}
      >
        <span className="font-mono text-[13px] text-accent">›</span>
        <input
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') send();
          }}
          placeholder="Interject this phase — folded in at the next turn boundary, no restart…"
          className="flex-1 bg-transparent text-[12.5px] text-text outline-none placeholder:text-faint"
        />
        <button
          type="button"
          onClick={send}
          disabled={!text.trim() || say.isPending}
          className="rounded-md px-3 py-1.5 text-[11px] font-medium text-white disabled:opacity-45"
          style={{ background: 'linear-gradient(145deg, var(--accent), var(--accent-2))' }}
        >
          Interject
        </button>
      </div>
      <p className="mt-1.5 text-center font-mono text-[9px] text-faint">interjecting one coding session — not the thread&apos;s brain</p>
    </div>
  );
}

// ── Docs ─────────────────────────────────────────────────────────────────────────────────────────
function PlanDoc({
  card,
  title,
  sections,
  threadRef,
}: {
  card: WebApprovalCard | null;
  title?: string;
  sections?: string[];
  threadRef: ThreadRef;
}) {
  const decisions = card?.decisions ?? [];
  const sectionList = card?.sections ?? sections ?? [];
  const value = card?.actions.find((a) => a.actionId === APPROVE_ACTION_ID)?.value ?? '';

  return (
    <div className="h-full overflow-y-auto px-8 py-7">
      <div className="max-w-[720px]">
        <div className="font-disp text-[22px] font-semibold tracking-[-0.01em] text-text">{title ?? card?.title ?? 'Plan'}</div>
        <div className="mt-1.5 mb-5 font-mono text-[10.5px] text-faint">
          {sectionList.length} section{sectionList.length === 1 ? '' : 's'} · plan.md
        </div>
        {card?.summary ? (
          <p className="mb-6 whitespace-pre-wrap text-[14px] leading-relaxed text-text">{card.summary}</p>
        ) : null}

        <DocLabel>LOCKED DECISIONS</DocLabel>
        {decisions.length === 0 ? (
          <p className="mb-6 text-[12.5px] text-dim">
            The decision record is locked at approval — its classified rulings become the build&apos;s input
            contract. (Open <span className="font-mono">decision-record.md</span> in the navigator.)
          </p>
        ) : (
          <div className="mb-6 flex flex-col gap-2.5">
            {decisions.map((d, i) => (
              <div key={i} className="flex items-start gap-2.5">
                <span className="whitespace-nowrap rounded border border-border bg-surface-3 px-1.5 py-0.5 font-mono text-[8.5px] uppercase tracking-[0.04em] text-dim">
                  {d.decisionClass.replace(/_/g, ' ')}
                </span>
                <span className="text-[13px] leading-relaxed text-text">
                  <span className="font-semibold">{d.title}</span> — {d.ruling}
                </span>
              </div>
            ))}
          </div>
        )}

        <DocLabel>SECTIONS</DocLabel>
        {sectionList.map((s, i) => (
          <div key={i} className="flex items-baseline gap-3 border-t py-2" style={{ borderColor: 'var(--hair)' }}>
            <span className="w-4 font-mono text-[11px] text-faint">{i + 1}</span>
            <span className="text-[13.5px] font-medium text-text">{sectionTitle(s)}</span>
          </div>
        ))}

        {card && value ? (
          <div className="mt-6">
            <VerdictButtons threadRef={threadRef} value={value} approveLabel="Approve & build →" size="md" />
          </div>
        ) : null}
      </div>
    </div>
  );
}

function DecisionDoc({ card }: { card: WebApprovalCard | null }) {
  const decisions = card?.decisions ?? [];
  return (
    <div className="h-full overflow-y-auto px-8 py-7">
      <div className="max-w-[720px]">
        <div className="font-disp text-[21px] font-semibold tracking-[-0.01em] text-text">Decision record</div>
        <div className="mt-1.5 mb-5 font-mono text-[10.5px] text-faint">locked at approval · the build&apos;s input contract</div>
        {decisions.length === 0 ? (
          <Placeholder
            title="Decision record"
            body="The locked decision record isn't exposed by the web surface yet. Each decision carries a class; new always-ask classes surfacing mid-build park the driver and ask you."
          />
        ) : (
          <div className="flex flex-col gap-3">
            {decisions.map((d, i) => (
              <div key={i} className="rounded-md border border-border bg-surface-2 px-3.5 py-3">
                <span className="font-mono text-[9px] uppercase tracking-[0.06em] text-dim">{d.decisionClass.replace(/_/g, ' ')}</span>
                <p className="mt-1 text-[13px] font-semibold text-text">{d.title}</p>
                <p className="mt-0.5 text-[12.5px] leading-relaxed text-dim">{d.ruling}</p>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

function SectionPlanDoc({ brief }: { brief: string }) {
  return (
    <div className="h-full overflow-y-auto px-8 py-7">
      <div className="max-w-[720px]">
        <div className="font-disp text-[21px] font-semibold tracking-[-0.01em] text-text">{brief}</div>
        <div className="mt-1.5 mb-5 font-mono text-[10.5px] text-faint">section plan</div>
        <Placeholder
          title="Section plan"
          body="The just-in-time section plan (its build phases) isn't exposed by the web surface yet. The planning step decides the phase split when the section starts."
        />
      </div>
    </div>
  );
}

function AutoFixView() {
  const lenses = [
    { name: 'best-practices', note: 'A self-review lens over the section diff.' },
    { name: 'correctness', note: 'A self-review lens over the section diff.' },
    { name: 'consistency', note: 'A self-review lens over the section diff.' },
  ];
  return (
    <div className="h-full overflow-y-auto px-6 py-5">
      <div className="flex max-w-[760px] flex-col gap-3">
        <Banner text="The 3-lens auto-fix runs over the section diff, then commits the fixes. Per-lens results aren't exposed by the web surface yet." />
        {lenses.map((l) => (
          <div key={l.name} className="rounded-md border border-border bg-surface px-4 py-3">
            <div className="flex items-center gap-2">
              <span className="h-1.5 w-1.5 rounded-full" style={{ background: 'var(--faint)' }} />
              <span className="text-[12.5px] font-semibold text-text">{l.name}</span>
            </div>
            <p className="mt-1.5 font-mono text-[10.5px] text-dim">{l.note}</p>
          </div>
        ))}
      </div>
    </div>
  );
}

// ── shared bits ──────────────────────────────────────────────────────────────────────────────────
function Placeholder({ title, body }: { title: string; body: string }) {
  return (
    <div className="flex h-full flex-col items-center justify-center text-center">
      <p className="text-[14px] font-semibold text-text">{title}</p>
      <p className="mt-1.5 max-w-md text-[12.5px] leading-relaxed text-dim">{body}</p>
    </div>
  );
}

function Banner({ text }: { text: string }) {
  return (
    <div className="flex items-start gap-2 rounded-md border border-border bg-surface-2 px-3 py-2 text-[11px] text-dim">
      <Info size={13} className="mt-px shrink-0 text-faint" />
      <span>{text}</span>
    </div>
  );
}

function DocLabel({ children }: { children: React.ReactNode }) {
  return <div className="mb-2.5 font-mono text-[9px] tracking-[0.14em] text-faint">{children}</div>;
}
