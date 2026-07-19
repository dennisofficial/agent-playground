'use client';

import { fetchAttachmentUrl, type JobRef } from '@/lib/api/job-api';
import type { WebAttachmentItem, WebAttachmentsCard } from '@/lib/api/types';
import { FileText } from 'lucide-react';
import { useContext, useEffect, useState } from 'react';
import { MessageTime, UserBubble } from './bubbles';
import { PremeasureContext } from './idle-premeasure';

/** Human file size (1 decimal for KB+). */
function fmtSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/**
 * One image thumbnail. Uses the optimistic `localUrl` (own blob) directly when present; otherwise fetches
 * the durable file from the STREAMING raw endpoint as a blob object-URL (never a base64 data URL) and
 * revokes it on unmount. `path === ""` means the durable row hasn't reconciled yet (no local preview) — we
 * simply wait for the refetch to replace this row.
 */
function ImageThumb({ jobRef, item }: { jobRef: JobRef; item: WebAttachmentItem }) {
  const [url, setUrl] = useState<string | null>(item.localUrl ?? null);
  // The idle off-screen pre-measurement pass mounts this same component to read its (fixed) box height —
  // it never needs the real image, so skip the network fetch there entirely.
  const measureOnly = useContext(PremeasureContext);

  useEffect(() => {
    if (measureOnly || item.localUrl || !item.path) return;
    let revoke: string | null = null;
    let alive = true;
    fetchAttachmentUrl(jobRef, item.path)
      .then((u) => {
        if (alive) {
          revoke = u;
          setUrl(u);
        } else {
          URL.revokeObjectURL(u);
        }
      })
      .catch(() => {});
    return () => {
      alive = false;
      if (revoke) URL.revokeObjectURL(revoke);
    };
  }, [measureOnly, jobRef, item.localUrl, item.path]);

  return (
    <div
      className="h-16 w-16 overflow-hidden rounded-lg border border-accent-line bg-surface"
      title={item.name}
    >
      {url ? (
        // eslint-disable-next-line @next/next/no-img-element -- blob object-URL, not a remote asset
        <img src={url} alt={item.name} className="h-full w-full object-cover" />
      ) : null}
    </div>
  );
}

/** One non-image file chip (name + size). */
function FileChip({ item }: { item: WebAttachmentItem }) {
  return (
    <div
      className="flex items-center gap-1.5 rounded-lg border border-accent-line bg-surface px-2 py-1.5"
      title={item.name}
    >
      <FileText size={13} strokeWidth={2} className="shrink-0 text-accent-2" />
      <span className="max-w-35 truncate text-[11px] text-text">{item.name}</span>
      <span className="font-mono text-[9px] text-dim">{fmtSize(item.size)}</span>
    </div>
  );
}

/**
 * The operator's composer attachments — a chip/thumbnail row rendered ON TOP, with the optional typed
 * caption as a normal `UserBubble` underneath (per the design: files above, my message below).
 */
export function AttachmentsCardView({
  card,
  jobRef,
  time,
}: {
  card: WebAttachmentsCard;
  jobRef: JobRef;
  time?: string;
}) {
  return (
    <div className="flex flex-col items-end gap-1">
      <div className="flex max-w-[80%] flex-wrap justify-end gap-1.5">
        {card.items.map((item, i) =>
          item.kind === 'image' ? (
            <ImageThumb key={i} jobRef={jobRef} item={item} />
          ) : (
            <FileChip key={i} item={item} />
          ),
        )}
      </div>
      {card.message ? (
        <UserBubble text={card.message} time={time} />
      ) : (
        <MessageTime iso={time} tone="user" align="right" />
      )}
    </div>
  );
}
