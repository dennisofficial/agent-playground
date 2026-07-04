import { codexReviewNode } from "@/features/job-workspace/codex-review";
import { ShieldCheck } from "lucide-react";
import { cn } from "@/lib/cn";

/** The CODEX REVIEW lane — the plan-review dialogue as its own navigator row (the review Main talks to).
 *  Clicking opens the `codex-review:<jobId>` transcript in the LEFT pane; the row highlights while it's the
 *  open lane. Status word: `reviewing` (running) · `done` (complete) · `failed`. */
export function PlanReviewRow({
  jobId,
  status,
  laneNode,
  onSelectNode,
}: {
  jobId: string;
  status: string;
  laneNode: string | null;
  onSelectNode: (node: string) => void;
}) {
  const node = codexReviewNode(jobId);
  const active = laneNode === node;
  const running = status === "running" || status === "reviewing";
  const failed = status === "failed";
  const word = failed ? "failed" : running ? "reviewing" : "done";
  const color = failed
    ? "var(--red)"
    : running
      ? "var(--blue)"
      : "var(--green)";
  return (
    <div
      className="border-l-[3px]"
      style={
        active
          ? {
              borderLeftColor: color,
              background: `color-mix(in srgb, ${color} 5%, transparent)`,
            }
          : { borderLeftColor: "transparent", background: "transparent" }
      }
    >
      <button
        type="button"
        onClick={() => onSelectNode(node)}
        className="flex w-full items-center gap-2 py-1.5 pl-1.5 pr-2 text-left transition hover:bg-surface-2"
      >
        <span className="grid h-[13px] w-[13px] shrink-0 place-items-center">
          <ShieldCheck size={11} style={{ color }} />
        </span>
        <span
          className={cn(
            "flex-1 truncate text-[12px]",
            active ? "font-semibold text-text" : "font-medium text-dim",
          )}
        >
          Codex review
        </span>
        <span className="shrink-0 font-mono text-[8px]" style={{ color }}>
          {word}
        </span>
      </button>
    </div>
  );
}
