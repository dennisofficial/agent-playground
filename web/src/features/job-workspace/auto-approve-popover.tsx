"use client";

import {
  type RefObject,
  useCallback,
  useEffect,
  useRef,
  useState,
} from "react";
import { createPortal } from "react-dom";
import { ShieldCheck, X } from "lucide-react";
import {
  type AutoApproveMode,
  modeApprovesPlan,
  modeApprovesShip,
} from "@workspace/shared";
import { cn } from "@/lib/cn";
import { composeMode } from "./auto-approve-mode";

const MARGIN = 8;
const WIDTH = 258;
const MIN_WIDTH = 180;

/**
 * The header "Auto" pill's popover — two independent switches (Plan gate / Ship gate) that compose into
 * one `AutoApproveMode`, plus a separate Merge section (a plain boolean, orthogonal to the approve mode).
 * Modeled on {@link SelectionCommentPopover}'s portal + `position:fixed` + dismiss pattern, but anchored
 * under the pill instead of a text selection.
 */
export function AutoApprovePopover({
  anchorRect,
  triggerRef,
  mode,
  onSelect,
  autoMerge,
  onSetMerge,
  onClose,
}: {
  anchorRect: DOMRect;
  /** The pill that opened this popover — excluded from outside-dismiss so clicking it toggles closed
   *  (rather than dismissing then reopening on the same click). */
  triggerRef: RefObject<HTMLElement | null>;
  mode: AutoApproveMode;
  onSelect: (mode: AutoApproveMode) => void;
  autoMerge: boolean;
  onSetMerge: (body: { autoMerge: boolean }) => void;
  onClose: () => void;
}) {
  const popRef = useRef<HTMLDivElement>(null);
  const draftRef = useRef(mode);
  const [draftMode, setDraftMode] = useState(mode);
  const [draftMerge, setDraftMerge] = useState(autoMerge);

  useEffect(() => {
    draftRef.current = mode;
    setDraftMode(mode);
  }, [mode]);

  useEffect(() => {
    setDraftMerge(autoMerge);
  }, [autoMerge]);

  const selectMode = useCallback(
    (next: AutoApproveMode) => {
      draftRef.current = next;
      setDraftMode(next);
      onSelect(next);
    },
    [onSelect],
  );

  const setPlan = useCallback(
    (nextPlan: boolean) => {
      selectMode(composeMode(nextPlan, modeApprovesShip(draftRef.current)));
    },
    [selectMode],
  );

  const setShip = useCallback(
    (nextShip: boolean) => {
      selectMode(composeMode(modeApprovesPlan(draftRef.current), nextShip));
    },
    [selectMode],
  );

  const setMerge = useCallback(
    (next: boolean) => {
      setDraftMerge(next);
      onSetMerge({ autoMerge: next });
    },
    [onSetMerge],
  );

  useEffect(() => {
    function onPointerDown(e: PointerEvent) {
      const t = e.target as Node;
      if (popRef.current?.contains(t) || triggerRef.current?.contains(t))
        return;
      onClose();
    }
    function onKeyDown(e: KeyboardEvent) {
      if (e.key === "Escape") onClose();
    }
    // Capture phase: the anchor rect was measured at click time, so any scroll/resize invalidates it —
    // dismiss rather than show a popover pinned to a stale position.
    function onStale() {
      onClose();
    }
    document.addEventListener("pointerdown", onPointerDown);
    document.addEventListener("keydown", onKeyDown);
    window.addEventListener("scroll", onStale, true);
    window.addEventListener("resize", onStale);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown);
      document.removeEventListener("keydown", onKeyDown);
      window.removeEventListener("scroll", onStale, true);
      window.removeEventListener("resize", onStale);
    };
  }, [onClose, triggerRef]);

  if (typeof document === "undefined") return null;

  const width = Math.min(
    WIDTH,
    Math.max(MIN_WIDTH, window.innerWidth - MARGIN * 2),
  );
  const left = Math.min(
    Math.max(MARGIN, anchorRect.right - width),
    Math.max(MARGIN, window.innerWidth - width - MARGIN),
  );
  const top = anchorRect.bottom + 6;

  const plan = modeApprovesPlan(draftMode);
  const ship = modeApprovesShip(draftMode);

  return createPortal(
    <div
      ref={popRef}
      data-testid="auto-approve-popover"
      role="dialog"
      aria-label="Automation settings"
      className="fixed z-[90] rounded-xl border border-border-2 bg-panel p-3 pb-3.5"
      style={{
        left,
        top,
        width,
        boxShadow: "var(--shadow-menu)",
      }}
    >
      <div className="mb-0.5 flex items-center gap-1.5">
        <ShieldCheck size={12} className="text-accent" strokeWidth={2.25} />
        <span className="font-mono text-[9.5px] font-semibold tracking-[0.06em] uppercase text-accent-2">
          Automation
        </span>
        <span className="flex-1" />
        <button
          type="button"
          onClick={onClose}
          className="rounded p-0.5 text-faint"
          aria-label="Close"
        >
          <X size={13} />
        </button>
      </div>
      <p className="pop-sub mb-2.5 text-[11px] leading-relaxed text-faint">
        Choose which gates this job clears without you.
      </p>

      <SwitchRow
        title="Plan"
        description="Approve the plan / direct-build gate automatically"
        checked={plan}
        first
        testId="auto-approve-plan"
        onChange={setPlan}
      />
      <SwitchRow
        title="Ship"
        description="Approve the ship-review gate automatically"
        checked={ship}
        testId="auto-approve-ship"
        onChange={setShip}
      />

      <div className="border-t border-border pt-2.5">
        <SwitchRow
          title="Merge"
          description="Merge the PR automatically once it's green & mergeable"
          checked={draftMerge}
          first
          testId="auto-merge-toggle"
          onChange={setMerge}
        />
      </div>

      <div className="mt-2.5 border-t border-border pt-2.5 text-[10px] leading-relaxed text-faint">
        Applies to this job only — you can flip any gate back at any time before
        it fires.
      </div>
    </div>,
    document.body,
  );
}

export function SwitchRow({
  title,
  description,
  checked,
  first,
  testId,
  onChange,
}: {
  title: string;
  description: string;
  checked: boolean;
  first?: boolean;
  testId: string;
  onChange: (next: boolean) => void;
}) {
  return (
    <div
      className={cn(
        "flex items-start gap-2.5 border-border py-2.5",
        first ? "border-t-0 pt-0.5" : "border-t",
      )}
    >
      <div className="min-w-0 flex-1">
        <p className="mb-0.5 text-[12.5px] font-semibold text-text">{title}</p>
        <p className="text-[10.5px] leading-snug text-faint">{description}</p>
      </div>
      <button
        type="button"
        role="switch"
        aria-checked={checked}
        aria-label={`Auto-approve ${title.toLowerCase()} gate`}
        data-testid={testId}
        onClick={() => onChange(!checked)}
        className="relative mt-px h-[17px] w-[30px] shrink-0 rounded-full border transition-colors"
        style={{
          background: checked ? "var(--green)" : "var(--surface-3)",
          borderColor: checked ? "var(--green)" : "var(--border-2)",
        }}
      >
        <span
          className="absolute top-[1px] left-[1px] h-[13px] w-[13px] rounded-full bg-white transition-transform"
          style={{
            transform: checked ? "translateX(13px)" : "translateX(0)",
            boxShadow: "0 1px 2px rgba(0, 0, 0, 0.25)",
          }}
        />
      </button>
    </div>
  );
}
