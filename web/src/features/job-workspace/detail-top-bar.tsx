"use client";

import type React from "react";

/**
 * The single top bar shared by the main conversation AND every lane/detail pane (build thread/step, subagent
 * runs, plan/decision/diff/file views). Left = a lane-style title + optional subtitle; right = the standard
 * action buttons (search / copy / diff / resume). Both the conversation and the lane views render THIS, so the
 * header is identical everywhere — no more per-view header drift.
 */
export function DetailTopBar({
  title,
  subtitle,
  actions,
}: {
  title: string;
  subtitle?: string;
  /** Right-aligned controls. Defaults to the standard {@link TopBarActions} group. */
  actions?: React.ReactNode;
}) {
  return (
    <div className="flex h-11 shrink-0 items-center gap-2.5 border-b border-border bg-surface px-5">
      <div className="flex min-w-0 flex-1 flex-col justify-center">
        <span className="truncate font-disp text-[13.5px] font-semibold leading-tight text-text">
          {title}
        </span>
        {subtitle ? (
          <span className="truncate font-mono text-[10px] leading-tight text-faint">
            {subtitle}
          </span>
        ) : null}
      </div>
      {actions === undefined ? <TopBarActions /> : actions}
    </div>
  );
}

/**
 * The standard right-side action cluster — search / copy / view-diff / resume. Search and diff are static
 * design-parity placeholders for now (no backend wiring). The copy slot is wired where the caller supplies a
 * working control via `copySlot` (e.g. the file detail view's {@link FileCopyButton}); otherwise it falls
 * back to the placeholder copy button.
 */
export function TopBarActions({
  copySlot,
}: {
  /** Replaces the placeholder copy button when provided; render `null` inside it to hide the copy action. */
  copySlot?: React.ReactNode;
}) {
  return (
    <div className="flex items-center gap-0.5">
      <TopBarButton title="Search this job">
        <svg
          width="15"
          height="15"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.8"
          strokeLinecap="round"
          strokeLinejoin="round"
        >
          <circle cx="11" cy="11" r="7" />
          <path d="M21 21l-4.35-4.35" />
        </svg>
      </TopBarButton>
      {copySlot === undefined ? (
        <TopBarButton title="Copy transcript">
          <svg
            width="15"
            height="15"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.8"
            strokeLinecap="round"
            strokeLinejoin="round"
          >
            <rect x="9" y="9" width="11" height="11" rx="2" />
            <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
          </svg>
        </TopBarButton>
      ) : (
        copySlot
      )}
      <button
        type="button"
        title="View diff · 4 files"
        className="flex h-[29px] items-center gap-1.5 rounded-sm px-2.5 text-dim transition hover:bg-surface-2 hover:text-text"
      >
        <svg
          width="15"
          height="15"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.8"
          strokeLinecap="round"
          strokeLinejoin="round"
        >
          <path d="M12 3v14" />
          <path d="M5 10h14" />
          <path d="M5 21h14" />
        </svg>
        <span className="font-mono text-[10px]">4</span>
      </button>
    </div>
  );
}

export function TopBarButton({
  title,
  onClick,
  children,
}: {
  title: string;
  onClick?: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      title={title}
      onClick={onClick}
      className="flex h-[29px] w-[29px] items-center justify-center rounded-sm text-dim transition hover:bg-surface-2 hover:text-text"
    >
      {children}
    </button>
  );
}
