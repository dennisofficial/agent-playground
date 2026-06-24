'use client';

import { useEffect, useRef, useState } from 'react';
import { MessageSquare, MoreHorizontal, Pencil, Trash2 } from 'lucide-react';
import { KindBadge, StatusPie } from '@/components/ui/badges';
import { STATUS_META } from '@/lib/api/status';
import { pipelineJob } from '@/lib/api/thread-api';
import { PipelineTree } from './pipeline-tree';
import type { PipelineJob, PipelineState, ThreadKind, ThreadStatus } from '@/lib/api/types';

export interface ThreadMeta {
  title: string;
  kind: ThreadKind;
  status: ThreadStatus;
  orgName: string;
  orgColor: string;
  repoName: string;
  branch?: string;
  tracker?: string;
  footer: string;
}

/**
 * The 288px thread navigator. A header (kind · status · title · org · branch) over a state-driven body:
 * the live pipeline tree (running / paused) or a state panel (scoping / approval / done / triaging).
 */
export function Navigator({
  meta,
  pipeline,
  selectedNode,
  convoActive,
  onConversation,
  onSelectNode,
  onRename,
  onDelete,
  deleting,
}: {
  meta: ThreadMeta;
  pipeline: PipelineState | undefined;
  selectedNode: string | null;
  convoActive: boolean;
  onConversation: () => void;
  onSelectNode: (node: string) => void;
  onRename?: (title: string) => void;
  onDelete?: () => void;
  deleting?: boolean;
}) {
  const job = pipelineJob(pipeline);
  const [editing, setEditing] = useState(false);

  return (
    <div
      className="flex w-72 shrink-0 flex-col overflow-hidden border-r border-border"
      style={{ background: 'color-mix(in srgb, var(--panel) 35%, transparent)' }}
    >
      {/* header */}
      <div className="border-b border-border px-4 py-3.5">
        <div className="mb-2 flex items-center gap-2">
          <KindBadge kind={meta.kind} />
          <span className="flex items-center gap-1.5 font-mono text-[9px] font-semibold uppercase tracking-[0.05em] text-accent">
            <StatusPie status={meta.status} size={13} />
            {STATUS_META[meta.status].label}
          </span>
          <div className="flex-1" />
          {onDelete || onRename ? (
            <ThreadMenu
              onStartRename={onRename ? () => setEditing(true) : undefined}
              onDelete={onDelete}
              deleting={deleting}
            />
          ) : null}
        </div>
        {editing && onRename ? (
          <input
            autoFocus
            defaultValue={meta.title}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                const v = e.currentTarget.value.trim();
                if (v && v !== meta.title) onRename(v);
                setEditing(false);
              } else if (e.key === 'Escape') {
                setEditing(false);
              }
            }}
            onBlur={() => setEditing(false)}
            className="w-full rounded border border-border-2 bg-surface px-1.5 py-0.5 font-disp text-[16px] font-semibold text-text outline-none focus:border-accent"
            aria-label="Thread title"
          />
        ) : (
          <div className="font-disp text-[16px] font-semibold leading-tight tracking-[-0.01em] text-text">
            {meta.title}
          </div>
        )}
        <div className="mt-2 flex items-center gap-2">
          <span className="h-1.5 w-1.5 shrink-0 rounded-sm" style={{ background: meta.orgColor }} />
          <span className="font-mono text-[9.5px] text-dim">{meta.orgName}</span>
        </div>
        <div className="mt-1.5 flex items-center gap-2 font-mono text-[9.5px] text-faint">
          <span>{meta.repoName}</span>
          {meta.branch ? (
            <>
              <span className="text-border-2">·</span>
              <span>{meta.branch}</span>
            </>
          ) : null}
          {meta.tracker ? (
            <>
              <span className="text-border-2">·</span>
              <span className="text-blue">{meta.tracker} ↗</span>
            </>
          ) : null}
        </div>
      </div>

      {/* body */}
      <div className="min-h-0 flex-1 overflow-y-auto px-2 py-3">
        {meta.status === 'running' || meta.status === 'paused' ? (
          job ? (
            <PipelineTree
              job={job}
              selectedNode={selectedNode}
              convoActive={convoActive}
              onConversation={onConversation}
              onSelectNode={onSelectNode}
            />
          ) : (
            <Panel label="PIPELINE" body="The pipeline is spinning up — sections will appear here." />
          )
        ) : meta.status === 'scoping' ? (
          <ScopingPanel />
        ) : meta.status === 'awaiting_approval' ? (
          <ApprovalPanel job={job} onConversation={onConversation} convoActive={convoActive} />
        ) : meta.status === 'done' ? (
          <DonePanel />
        ) : meta.status === 'triaging' ? (
          <Panel
            label="EVENT"
            body="An untrusted notification seeded this thread. The agent triaged it and parked one decision — answer it in the conversation."
          />
        ) : (
          <Panel label="STATUS" body="Open the conversation to see what's going on." />
        )}
      </div>

      <div className="border-t border-border px-3.5 py-2.5 text-[10px] leading-relaxed text-faint">
        {meta.footer}
      </div>
    </div>
  );
}

/** Kebab → "Rename thread" + a two-click "Delete thread" (real `PATCH` / `DELETE …/threads/:id`). */
function ThreadMenu({
  onStartRename,
  onDelete,
  deleting,
}: {
  onStartRename?: () => void;
  onDelete?: () => void;
  deleting?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [confirm, setConfirm] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    function onDoc(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) {
        setOpen(false);
        setConfirm(false);
      }
    }
    document.addEventListener('mousedown', onDoc);
    return () => document.removeEventListener('mousedown', onDoc);
  }, []);
  return (
    <div className="relative" ref={ref}>
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        className="rounded p-1 text-faint transition hover:bg-surface-2 hover:text-text"
        aria-label="Thread actions"
      >
        <MoreHorizontal size={15} />
      </button>
      {open ? (
        <div
          className="absolute right-0 top-[calc(100%+4px)] z-50 w-44 overflow-hidden rounded-md border border-border bg-panel py-1"
          style={{ boxShadow: 'var(--shadow-menu)' }}
        >
          {onStartRename ? (
            <button
              type="button"
              onClick={() => {
                onStartRename();
                setOpen(false);
                setConfirm(false);
              }}
              className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-[12px] text-text transition hover:bg-surface-2"
            >
              <Pencil size={13} className="text-dim" />
              Rename thread
            </button>
          ) : null}
          {onDelete ? (
            <button
              type="button"
              disabled={deleting}
              onClick={() => {
                if (confirm) {
                  onDelete();
                  setOpen(false);
                  setConfirm(false);
                } else {
                  setConfirm(true);
                }
              }}
              className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-[12px] text-red transition hover:bg-[color-mix(in_srgb,var(--red)_8%,transparent)] disabled:opacity-50"
            >
              <Trash2 size={13} />
              {deleting ? 'Deleting…' : confirm ? 'Click again to confirm' : 'Delete thread'}
            </button>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

function ConvoLink({ active, onClick, note }: { active: boolean; onClick: () => void; note?: string }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`mb-1.5 flex w-full items-center gap-2.5 rounded-sm px-2 py-1.5 text-left hover:bg-surface-2 ${
        active ? 'bg-[var(--accent-soft)]' : ''
      }`}
    >
      <MessageSquare size={13} className="text-accent" />
      <span className="flex-1 text-[12px] font-semibold">Conversation</span>
      {note ? <span className="font-mono text-[8px] text-purple">{note}</span> : null}
    </button>
  );
}

function ScopingPanel() {
  return (
    <div className="flex flex-col gap-1">
      <Label>PLANNING — IN THE CONVERSATION</Label>
      <p className="px-2 pb-3 text-[11.5px] leading-relaxed text-dim">
        No pipeline yet. A new thread is pure conversation — intent, grilling, then a plan. The plan you
        approve in the chat is what creates these sections.
      </p>
      <Label>FORMING</Label>
      <Forming icon="📄" name="plan.md" tag="drafting" pulse />
      <Forming icon="🔒" name="decision-record.md" tag="forming" />
      <Forming icon="▸" name="sections" tag="draft" />
    </div>
  );
}

function ApprovalPanel({
  job,
  onConversation,
  convoActive,
}: {
  job: PipelineJob | null;
  onConversation: () => void;
  convoActive: boolean;
}) {
  return (
    <div className="flex flex-col gap-1">
      <ConvoLink active={convoActive} onClick={onConversation} note="approval pending" />
      <Label>PROPOSED · for review</Label>
      <p className="px-2 pb-2.5 text-[11.5px] leading-relaxed text-dim">
        The approval card is inline in the conversation — that&apos;s the gate. These are the sections it
        will create on approve.
      </p>
      {(job?.sections ?? []).map((s, i) => (
        <div key={s.id} className="flex items-center gap-2.5 px-2 py-1.5">
          <span className="font-mono text-[9px] text-faint">{i + 1}</span>
          <span className="flex-1 truncate text-[11.5px]">{s.brief}</span>
        </div>
      ))}
    </div>
  );
}

function DonePanel() {
  return (
    <div className="flex flex-col gap-1">
      <Label>ARTIFACTS</Label>
      <Artifact icon="📄" name="plan.md" />
      <Artifact icon="🔒" name="decision-record.md" dim />
      <Artifact icon="⑃" name="pull request" dim />
      <Artifact icon="🐳" name="sandbox" dim />
    </div>
  );
}

function Panel({ label, body }: { label: string; body: string }) {
  return (
    <div className="flex flex-col gap-1">
      <Label>{label}</Label>
      <p className="px-2 text-[11.5px] leading-relaxed text-dim">{body}</p>
    </div>
  );
}

function Label({ children }: { children: React.ReactNode }) {
  return <div className="px-2 pb-1.5 pt-0.5 font-mono text-[9px] tracking-[0.16em] text-faint">{children}</div>;
}

function Forming({ icon, name, tag, pulse }: { icon: string; name: string; tag: string; pulse?: boolean }) {
  return (
    <div className="flex items-center gap-2.5 px-2 py-1.5">
      <span className="text-[12px] opacity-50">{icon}</span>
      <span className="flex-1 font-mono text-[11px] text-dim">{name}</span>
      <span className={`font-mono text-[8px] ${pulse ? 'pulse-dot text-accent' : 'text-faint'}`}>{tag}</span>
    </div>
  );
}

function Artifact({ icon, name, dim }: { icon: string; name: string; dim?: boolean }) {
  return (
    <div className="flex items-center gap-2.5 px-2 py-1.5">
      <span className="text-[12px]">{icon}</span>
      <span className={`flex-1 font-mono text-[11px] ${dim ? 'text-dim' : 'text-text'}`}>{name}</span>
    </div>
  );
}
