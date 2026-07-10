"use client";

import { Pencil } from "lucide-react";
import { MessageTime, UserBubble } from "./bubbles";
import { Markdown } from "./markdown";
import type { WebReviewCommentsCard } from "@/lib/api/types";

/**
 * A sent review-comment bundle ("Atlas Workspace HiFi") — the styled card an operator's queued
 * highlight-and-comment batch becomes once sent. Grouped by file; the operator's optional typed prose
 * renders as a normal `UserBubble` underneath (per the design: "my message underneath it").
 */
export function ReviewCommentsCardView({
  card,
  time,
}: {
  card: WebReviewCommentsCard;
  time?: string;
}) {
  const byFile = new Map<string, { quote: string; note?: string }[]>();
  for (const item of card.items) {
    const list = byFile.get(item.file);
    if (list) list.push(item);
    else byFile.set(item.file, [item]);
  }
  const fileLabel =
    byFile.size === 1 ? [...byFile.keys()][0] : `${byFile.size} files`;
  const countLabel = `${card.items.length} comment${card.items.length === 1 ? "" : "s"}`;

  return (
    <div className="flex flex-col items-end gap-1">
      <div
        className="flex max-w-[80%] min-w-0 flex-col gap-[9px] rounded-[13px] rounded-br-[4px] px-[13px] py-[11px] sm:min-w-[250px]"
        style={{
          background: "var(--accent-soft)",
          border: "1px solid var(--accent-line)",
        }}
      >
        <div className="flex items-center gap-1.5 font-mono text-[8px] font-semibold uppercase tracking-[0.06em] text-accent-2">
          <Pencil size={10} strokeWidth={2.2} />
          Review · {fileLabel} · {countLabel}
        </div>
        <div className="flex flex-col gap-2">
          {[...byFile.entries()].map(([file, items]) => (
            <div key={file} className="flex flex-col gap-2">
              {byFile.size > 1 ? (
                <div className="font-mono text-[9px] font-semibold uppercase tracking-[0.06em] text-accent-2">
                  {file}
                </div>
              ) : null}
              {items.map((it, i) => (
                <div
                  key={i}
                  className="border-l-2 pl-[9px]"
                  style={{ borderColor: "var(--accent-line)" }}
                >
                  <div className="font-mono text-[10px] leading-relaxed text-accent-2">
                    &ldquo;{it.quote}&rdquo;
                  </div>
                  {it.note ? (
                    <div className="mt-0.5 text-[12px] leading-relaxed text-text [&_p]:my-0 [&_p]:text-[12px] [&_p]:leading-relaxed">
                      <Markdown>{it.note}</Markdown>
                    </div>
                  ) : null}
                </div>
              ))}
            </div>
          ))}
        </div>
      </div>
      {card.message ? (
        <UserBubble text={card.message} time={time} />
      ) : (
        <MessageTime iso={time} tone="user" align="right" />
      )}
    </div>
  );
}
