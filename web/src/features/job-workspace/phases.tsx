'use client';

import { useState } from 'react';
import { ChevronRight, Hammer } from 'lucide-react';
import type { JobMessage } from '@/lib/api/job-api';
import { useLiveTurn, type LiveBlock } from '@/lib/api/job-stream';
import { durableSubBlocks, type SubBlock } from './subagents';
import { Markdown } from './markdown';

/**
 * A build PHASE (a driver batch) rides the shared transcript spine on a `phase:<anchorStepId>` lane and
 * tags every durable block with `meta.phaseId = anchorStepId`. Like a subagent run, that activity is peeled
 * OUT of the main conversation: the per-block transcript lives in the step sub-page, and a compact
 * `BuildStepCard` stands in for it in the conversation.
 *
 * Unlike a subagent there is NO spawning Task tool block, so the driver persists ONE synthetic
 * `kind:'build_anchor'` row per batch (at batch start) — that row is the card's anchor.
 */

/**
 * The live-stream lane a build THREAD streams on — STABLE per thread (like the brain's `main`), so the web
 * subscribes by thread identity instead of guessing the active per-batch lane. Every batch of a thread
 * streams on this one lane; durable blocks stay tagged with `meta.phaseId` for step-level attribution.
 */
export const threadLane = (threadId: string): string => `thread:${threadId}`;

/**
 * @deprecated build turns no longer stream on a per-phase lane — use {@link threadLane}. Kept only to derive
 * a legacy `phase:` lane if one is ever encountered; the durable `meta.phaseId` attribution is unchanged.
 */
export const phaseLane = (anchorStepId: string): string => `phase:${anchorStepId}`;

export interface PhaseAnchor {
  /** The anchor step id (== the batch's transcript tag + the navigator node). */
  phaseId: string;
  /** The owning build thread's id — the STABLE live lane the batch streams on (`threadLane(threadId)`). */
  threadId?: string;
  /** A human label (e.g. "Backend — 2 steps (…)"). */
  label: string;
  /** The batch ordinal within its thread (null if not recorded). */
  batchOrdinal: number | null;
  /** Every step id packed into this batch (one transcript serves them all). */
  batchStepIds: string[];
  /** The instruction the engine received — the build turn's "first message" (rendered like a Task prompt). */
  prompt?: string;
  /** `message.ts` of the `build_anchor` row (its chronological position in the conversation). */
  ts: string;
}

export interface PhaseIndex {
  /** `message.ts` of every block produced by a phase (skip these in the main conversation log). */
  childKeys: Set<string>;
  /** `message.ts` of every `build_anchor` row (render these as a card, not as prose). */
  anchorKeys: Set<string>;
  /** phaseId → its transcript blocks (the `build_anchor` row excluded), in order. */
  blocksByPhase: Map<string, JobMessage[]>;
  /** phaseId → the batch's anchor metadata. */
  anchorByPhase: Map<string, PhaseAnchor>;
}

/** Index a thread's durable log: peel phase blocks out of the main conversation + collect per-phase data. */
export function indexPhaseBlocks(messages: JobMessage[]): PhaseIndex {
  const childKeys = new Set<string>();
  const anchorKeys = new Set<string>();
  const blocksByPhase = new Map<string, JobMessage[]>();
  const anchorByPhase = new Map<string, PhaseAnchor>();
  for (const m of messages) {
    const phaseId = typeof m.meta?.phaseId === 'string' ? (m.meta.phaseId as string) : null;
    if (!phaseId) continue;
    if (m.kind === 'build_anchor') {
      anchorKeys.add(m.ts);
      anchorByPhase.set(phaseId, {
        phaseId,
        ...(typeof m.meta?.threadId === 'string' ? { threadId: m.meta.threadId as string } : {}),
        label: typeof m.meta?.label === 'string' ? (m.meta.label as string) : m.text || 'Build step',
        batchOrdinal: typeof m.meta?.batchOrdinal === 'number' ? (m.meta.batchOrdinal as number) : null,
        batchStepIds: Array.isArray(m.meta?.batchStepIds) ? (m.meta.batchStepIds as string[]) : [phaseId],
        prompt: typeof m.meta?.prompt === 'string' ? (m.meta.prompt as string) : undefined,
        ts: m.ts,
      });
      continue;
    }
    childKeys.add(m.ts);
    const arr = blocksByPhase.get(phaseId) ?? [];
    arr.push(m);
    blocksByPhase.set(phaseId, arr);
  }
  return { childKeys, anchorKeys, blocksByPhase, anchorByPhase };
}

/**
 * The opening "what was asked" block on a build THREAD/STEP lane — the instruction the engine received
 * (goal + locked decisions + per-step briefs). It's a long generated markdown DOCUMENT, not an operator
 * chat line, so it renders as a full-width, collapsible panel with a real markdown body — NOT a right-
 * aligned prose bubble, which showed the raw `###`/`**` source and read as a chat message the operator
 * never typed. Default-open so each lane still opens with "what was asked"; collapse to get out of the way.
 */
export function BuildInstruction({ text }: { text: string }) {
  const [open, setOpen] = useState(true);
  return (
    <div
      className="anim-fadeUp rounded-[9px] border"
      style={{ borderColor: 'var(--border-2)', background: 'color-mix(in srgb, var(--surface-2) 60%, transparent)' }}
    >
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        className="flex w-full items-center gap-2 rounded-t-[8px] px-3.5 py-2 text-left"
        style={{
          borderBottom: open ? '1px solid var(--border)' : 'none',
          background: 'color-mix(in srgb, var(--surface-3) 70%, transparent)',
        }}
      >
        <ChevronRight
          size={11}
          strokeWidth={2.6}
          className={`shrink-0 text-faint transition-transform ${open ? 'rotate-90' : ''}`}
        />
        <Hammer size={12} className="shrink-0 text-dim" />
        <span className="font-mono text-[10px] font-semibold uppercase tracking-[0.12em] text-dim">
          Build instruction
        </span>
        <span className="truncate font-mono text-[10px] text-faint">what this thread was asked to do</span>
      </button>
      {open ? (
        <div className="px-3.5 py-3">
          <Markdown>{text}</Markdown>
        </div>
      ) : null}
    </div>
  );
}

/** Durable transcript blocks for one phase (reuses the subagent block mapper — same shape). */
export function durablePhaseBlocks(index: PhaseIndex, phaseId: string): SubBlock[] {
  return durableSubBlocks(index.blocksByPhase.get(phaseId) ?? []);
}

/** Flatten one phase LANE's live blocks into the shared transcript-block shape (during the build). */
export function livePhaseBlocks(blocks: LiveBlock[]): SubBlock[] {
  return blocks.map((b): SubBlock =>
    b.kind === 'tool'
      ? { kind: 'tool', key: b.key, name: b.name, input: b.input, result: b.result, isError: b.isError, running: !b.done }
      : { kind: b.kind, key: b.key, text: b.text, running: !b.done },
  );
}

/**
 * The compact card that stands in for a build phase in the MAIN conversation. Its transcript (thinking +
 * prose + tool calls) lives in the step sub-page, opened via "Viewing run →". Subscribes to the phase's
 * live lane so it pulses while building and shows a live tool count, falling back to the durable count.
 */
export function BuildStepCard({
  jobId,
  anchor,
  durableToolCount,
  onOpen,
}: {
  jobId: string;
  anchor: PhaseAnchor;
  durableToolCount: number;
  onOpen: () => void;
}) {
  const [open, setOpen] = useState(false);
  // Subscribe to the thread's STABLE live lane (falling back to the legacy phase lane only for old anchors
  // persisted before the thread-lane cutover). This pulses "building" whenever the thread's batch is live.
  const live = useLiveTurn(jobId, anchor.threadId ? threadLane(anchor.threadId) : phaseLane(anchor.phaseId));
  const running = live?.active ?? false;
  const toolCount = running ? live!.blocks.filter((b) => b.kind === 'tool').length : durableToolCount;
  const stepCount = anchor.batchStepIds.length;

  return (
    <div
      className="anim-fadeUp my-px rounded-[10px] border"
      style={{
        borderColor: running ? 'var(--accent-line)' : 'var(--border)',
        background: running ? 'var(--accent-soft)' : 'color-mix(in srgb, var(--surface-2) 55%, transparent)',
      }}
    >
      <div className="flex items-center gap-2.5 px-3 py-2.5">
        <span
          className="flex h-6 w-6 shrink-0 items-center justify-center rounded-md"
          style={{ background: 'linear-gradient(145deg, var(--accent), var(--accent-2))' }}
          aria-hidden
        >
          <Hammer size={13} color="#fff" />
        </span>
        <div className="flex min-w-0 flex-1 flex-col">
          <div className="flex items-center gap-2">
            <span className="truncate text-[12.5px] font-semibold text-text">Build step</span>
            {stepCount > 1 ? (
              <span className="rounded-sm bg-surface-3 px-1.5 py-px font-mono text-[8.5px] uppercase tracking-[0.1em] text-faint">
                {stepCount} steps batched
              </span>
            ) : null}
            <span className="flex items-center gap-1 font-mono text-[9.5px] uppercase tracking-[0.1em] text-faint">
              {running ? (
                <span className="pulse-dot h-1.5 w-1.5 rounded-full" style={{ background: 'var(--accent)' }} />
              ) : null}
              {running ? 'building' : 'done'}
            </span>
          </div>
          {anchor.label ? <span className="mt-0.5 truncate text-[11.5px] text-dim">{anchor.label}</span> : null}
          <span className="mt-0.5 font-mono text-[10px] text-faint">
            {toolCount} tool{toolCount === 1 ? '' : 's'} · Claude · execute
          </span>
        </div>
        <button
          type="button"
          onClick={onOpen}
          className="flex shrink-0 items-center gap-1 rounded-md px-2.5 py-1.5 text-[11.5px] font-medium text-accent transition hover:bg-surface-3"
          style={{ background: 'var(--accent-soft)', border: '1px solid var(--accent-line)' }}
        >
          Viewing run →
        </button>
      </div>
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        className="flex w-full items-center gap-1.5 border-t px-3 py-1.5 text-left font-mono text-[10px] text-faint transition hover:text-dim"
        style={{ borderColor: 'var(--hair)' }}
      >
        <ChevronRight size={10} strokeWidth={2.6} className={`shrink-0 transition-transform ${open ? 'rotate-90' : ''}`} />
        batch detail
      </button>
      {open ? (
        <p className="px-3 pb-2.5 font-mono text-[10.5px] leading-relaxed text-dim">
          {stepCount > 1 ? `${stepCount} steps built together as one turn` : 'one step'}
          {anchor.batchOrdinal != null ? ` · batch ${anchor.batchOrdinal}` : ''}
          {' · '}id: <span className="text-text">{anchor.phaseId.slice(0, 12)}…</span>
        </p>
      ) : null}
    </div>
  );
}
