'use client';

import { Button } from '@/components/ui/button';
import type { JobRef } from '@/lib/api/job-api';
import { useApproveSkillProposal } from '@/lib/api/job-queries';
import { useOrg } from '@/lib/api/me';
import type { WebSkillProposalCard } from '@/lib/api/types';
import { BookOpen, CheckCircle2, Download, Lock, Trash2 } from 'lucide-react';
import { Markdown } from '../conversation/markdown';

const HEAD: Record<
  WebSkillProposalCard['mode'],
  { icon: typeof BookOpen; label: string; cta: string; pending: string }
> = {
  install: {
    icon: Download,
    label: 'Install a maintained skill',
    cta: 'Approve & install',
    pending: 'Installing…',
  },
  create: {
    icon: BookOpen,
    label: 'New skill',
    cta: 'Approve & add',
    pending: 'Adding…',
  },
  remove: {
    icon: Trash2,
    label: 'Remove a skill',
    cta: 'Approve removal',
    pending: 'Removing…',
  },
};

/**
 * An owner-approvable SKILL proposal the brain posed. `install` reuses a maintained skill from a git
 * marketplace (previewing the exact resolved skill + any overwrite); `create` adds a skill the brain
 * authored as real files (previewing SKILL.md + the file tree); `remove` deletes a registered skill. The
 * brain never writes/installs itself — the OWNER approves here. Once `approved_at` is set, renders compact.
 */
export function SkillProposalCard({
  card,
  jobRef,
}: {
  card: WebSkillProposalCard;
  jobRef: JobRef;
}) {
  const approve = useApproveSkillProposal(jobRef);
  const org = useOrg(jobRef.orgId);
  const isOwner = org?.role === 'owner';
  const head = HEAD[card.mode];
  const Icon = head.icon;

  if (card.approved_at != null) {
    const verb =
      card.mode === 'remove' ? 'removed' : card.mode === 'install' ? 'installed' : 'added';
    return (
      <div className="anim-pop self-stretch overflow-hidden rounded-lg border border-border bg-surface">
        <div className="flex items-center gap-2.5 px-4 py-3">
          <CheckCircle2 size={15} style={{ color: 'var(--green)' }} />
          <div className="min-w-0">
            <p className="text-[13px] font-medium text-text">Skill {verb}</p>
            <p className="truncate text-[12.5px] text-dim">
              <span className="mr-1.5 font-mono">{card.name}</span>
              <span className="text-faint">({card.scope}-scoped)</span>
            </p>
          </div>
        </div>
      </div>
    );
  }

  const installRows = card.installPreview?.rows ?? [];

  return (
    <div className="anim-pop self-stretch overflow-hidden rounded-lg border border-border bg-surface">
      <div className="flex items-center gap-2.5 border-b border-border px-4 py-3">
        <Icon size={15} className="text-accent" />
        <span className="text-[13px] font-semibold text-text">{head.label}</span>
        <div className="flex-1" />
        <span className="rounded-full border border-border px-2 py-0.5 font-mono text-[9.5px] uppercase text-dim">
          {card.scope}
        </span>
      </div>

      <div className="flex flex-col gap-2.5 px-4 py-3">
        {card.mode === 'install'
          ? installRows.map((r) => (
              <div key={r.name} className="rounded-md border border-border bg-surface-2 px-3 py-2">
                <div className="flex items-center gap-2">
                  <span className="font-mono text-[12.5px] font-semibold text-text">{r.name}</span>
                  {r.overwrites ? (
                    <span className="rounded-full border border-border px-1.5 py-0.5 text-[9.5px] text-amber">
                      overwrites existing
                    </span>
                  ) : null}
                </div>
                <p className="mt-0.5 text-[12px] text-dim">{r.description}</p>
              </div>
            ))
          : null}

        {card.mode === 'create' ? (
          <div className="rounded-md border border-border bg-surface-2 px-3 py-2">
            <span className="font-mono text-[12.5px] font-semibold text-text">{card.name}</span>
            <p className="mt-0.5 text-[12px] text-dim">{card.description}</p>
            {card.preview?.files?.length ? (
              <ul className="mt-1.5 flex flex-col gap-0.5">
                {card.preview.files.map((f) => (
                  <li key={f} className="font-mono text-[11px] text-faint">
                    {f}
                  </li>
                ))}
              </ul>
            ) : null}
          </div>
        ) : null}

        {card.mode === 'remove' ? (
          <div className="rounded-md border border-border bg-surface-2 px-3 py-2">
            <span className="font-mono text-[12.5px] font-semibold text-text">{card.name}</span>
            <p className="mt-0.5 text-[12px] text-dim">
              This skill will be deleted from every future build.
            </p>
          </div>
        ) : null}

        {card.mode === 'install' && card.sourceUrl ? (
          <p className="truncate font-mono text-[11px] text-faint">
            {card.sourceUrl}
            {card.sourceSubpath ? `/${card.sourceSubpath}` : ''}
            {card.sourceRef ? `@${card.sourceRef}` : ''}
          </p>
        ) : null}
        {card.mode === 'create' && card.preview?.skillMd ? (
          <details className="rounded-md border border-border bg-surface-2 px-3 py-2">
            <summary className="cursor-pointer text-[11.5px] text-dim">Preview SKILL.md</summary>
            <div className="mt-1.5 max-h-64 overflow-auto text-[12px] text-dim">
              <Markdown>{card.preview.skillMd}</Markdown>
            </div>
          </details>
        ) : null}

        {card.rationale ? (
          <div className="text-[12px] text-dim">
            <Markdown>{card.rationale}</Markdown>
          </div>
        ) : null}
      </div>

      <div className="flex flex-col gap-2 border-t border-border bg-surface-2 px-4 py-3">
        {isOwner ? (
          <div className="flex flex-wrap items-center gap-2">
            <Button
              size="sm"
              loading={approve.isPending}
              loadingText={head.pending}
              onClick={() => approve.mutate(card.requestId)}
            >
              {head.cta}
            </Button>
            {approve.isError ? (
              <span className="text-[11.5px] text-red">Could not complete that. Try again.</span>
            ) : null}
          </div>
        ) : (
          <div className="flex items-center gap-2 text-[11.5px] text-dim">
            <Lock size={13} />
            Only an owner can approve skills.
          </div>
        )}
      </div>
    </div>
  );
}
