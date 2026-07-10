import type { PipelineJob } from "@/lib/api/types";
import { threadLane } from "./phases";
import { codexReviewLane } from "./codex-review";

/**
 * THE NODE REGISTRY — the single source of truth for how a navigator `?node=`/`?lane=` token is
 * constructed, which pane it opens in, whether it still resolves against the live job, and (for the
 * transcript-backed ones) which live/durable lane it renders. Every conversational node is a "thread": the
 * Main brain, a build/track thread, a review lens, the post-review fix turn, the Codex plan-review dialogue
 * — they all ride the ONE {@link TranscriptView} on a lane string this registry produces.
 *
 * The DETAIL-pane view bodies still live in `step-view.tsx` (they need React hooks + per-branch queries, so
 * they can't be pure data here) — but they dispatch off this registry's builders/placement/lane so the
 * matching logic isn't re-implemented in four places (this file, `use-selected-node`, `step-view`,
 * `pipeline-tree`).
 */

export type NodeResolution = "loading" | "found" | "not_found";

// ── node-id builders ─────────────────────────────────────────────────────────────────────────────
/** Every conversational thread — a build thread/step leaf AND a review CHILD thread (a `review_lens` or the
 *  `post_review` fix turn) — is a BARE id (no prefix); it opens in the LEFT lane pane. The old
 *  `rev:<tid>:<agent>` / `fix:<tid>` synthetic ids are gone: review children are real thread rows, so they
 *  are addressed by their own id and their lane comes from the pipeline data (`PipelineReviewChild.lane`). */
export const threadNode = (threadId: string): string => threadId;
export const stepNode = (stepId: string): string => stepId;

// ── stacked repo-file view id (rides its own `?file=` param, like `subagent:` rides `?sub=`) ─────────
/** A stacked repo-file view id: `file:<path>` with an optional `::L<a>[-<b>]` line target. */
export const fileNode = (path: string, lines?: string): string =>
  `file:${path}${lines ? `::L${lines}` : ""}`;

/** Parse a `file:<path>[::L<lines>]` token back to its parts, or null if it isn't a file node. */
export function parseFileNode(
  token: string,
): { path: string; lines: string | null } | null {
  if (!token.startsWith("file:")) return null;
  const rest = token.slice("file:".length);
  const i = rest.indexOf("::L");
  return i >= 0
    ? { path: rest.slice(0, i), lines: rest.slice(i + 3) }
    : { path: rest, lines: null };
}

// ── placement: which pane a node opens in ───────────────────────────────────────────────────────
/** Literals that render from card/derived data in the RIGHT detail pane. */
const DETAIL_LITERALS = new Set(["plan", "decision", "diff", "tickets"]);
/** Prefixed detail-pane nodes (files, ports, services, section plans). Review lenses (`rev:`) and the
 *  post-review fix turn (`fix:`) are THREADS, not detail nodes — they open in the LEFT lane pane like the
 *  build/Codex-review threads (the RIGHT pane is reserved for tool-called sub-agents + outputs/docs). */
const DETAIL_PREFIX = /^(spec|gen|artifact|port|secplan|service):/;

/** Whether a node opens in the RIGHT (detail) pane rather than the LEFT (lane/conversation) one.
 *  (`subagent:` is neither — it stacks via `?sub=`, handled in `use-selected-node`.) */
export function isDetailNode(node: string): boolean {
  return DETAIL_LITERALS.has(node) || DETAIL_PREFIX.test(node);
}

// ── resolution (a stale `?node=`/`?lane=` → not-found) ──────────────────────────────────────────
/** Literals that render from card / derived data — no live-id dependency, always resolvable. */
const ID_FREE_NODES = new Set(["plan", "decision", "diff", "tickets"]);

/**
 * Classify a node token against the live job. Job-derived tokens (`secplan:`/`rev:`/`fix:` carry a thread
 * id; a bare token is a thread or step id) become `not_found` when their id is gone — otherwise a stale URL
 * would render a misleading generic placeholder or a silently-empty view. `spec:`/`artifact:` self-handle a
 * missing file inside `FileView`, so they stay `found`.
 *
 * IMPORTANT: this takes only `loading` (not `error`). A background pipeline refetch can fail while React
 * Query STILL holds the last-good `job` — the nav renders from that cache, so the detail pane must resolve
 * against it too rather than blanking every node to `not_found` on a transient error. `loading` matters only
 * when there is no cached `job` at all.
 */
export function resolveNode(
  node: string,
  job: PipelineJob | null,
  loading: boolean,
): NodeResolution {
  if (ID_FREE_NODES.has(node)) return "found";
  if (
    node.startsWith("spec:") ||
    node.startsWith("gen:") ||
    node.startsWith("artifact:")
  )
    return "found";
  // Subagent runs self-handle a missing run inside SubagentView. Always resolvable.
  if (node.startsWith("subagent:")) return "found";
  // A stacked repo-file view self-handles a missing/deleted file inside FilePane. Always resolvable.
  if (node.startsWith("file:")) return "found";
  // The Codex review lane self-handles an empty transcript inside TranscriptView. Always resolvable.
  if (node.startsWith("codex-review:")) return "found";
  // Sandbox ports are a design-stage mock — always resolvable.
  if (node.startsWith("port:")) return "found";
  // Supervised services self-handle a missing marker inside ServiceLogView — always resolvable, like ports.
  if (node.startsWith("service:")) return "found";

  // A background refetch can flip React Query to `error` (or briefly `loading`) while it STILL holds the
  // last-good pipeline; resolve against that cached `job` rather than blanking a node that still exists. Only
  // when there is genuinely no job do loading/error decide the fallback (loading → spinner; else not_found).
  if (!job) return loading ? "loading" : "not_found";

  if (node.startsWith("secplan:"))
    return hasThread(job, node.slice("secplan:".length))
      ? "found"
      : "not_found";
  // A per-Leg node (`<threadId>~leg<ordinal>`) resolves when the thread has that Leg.
  const legRef = parseLegNode(node);
  if (legRef) {
    const t = job.threads.find((s) => s.id === legRef.threadId);
    return t && (t.legs ?? []).some((l) => l.ordinal === legRef.ordinal)
      ? "found"
      : "not_found";
  }
  // Bare token — a thread, a step leaf, or a review CHILD thread (a `review_lens` / `post_review` row). A
  // review child legitimately exists even before its lens has run (an empty transcript is a TranscriptView
  // empty-state, not a not-found).
  const matches = job.threads.some(
    (s) =>
      s.id === node ||
      s.steps.some((p) => p.id === node) ||
      (s.children ?? []).some((c) => c.id === node),
  );
  return matches ? "found" : "not_found";
}

function hasThread(job: PipelineJob, id: string): boolean {
  return id.length > 0 && job.threads.some((s) => s.id === id);
}

/** A per-Leg navigable node id: `<threadId>~leg<ordinal>`. Each rotated build session (Leg) is its own
 *  left-pane node, opening the thread's lane filtered to that Leg's `meta.legOrdinal`. */
export function legNodeId(threadId: string, ordinal: number): string {
  return `${threadId}~leg${ordinal}`;
}

/** Parse a `<threadId>~leg<ordinal>` node back to its parts, or null if it isn't a Leg node. */
export function parseLegNode(
  node: string,
): { threadId: string; ordinal: number } | null {
  const m = /^(.+)~leg(\d+)$/.exec(node);
  return m ? { threadId: m[1], ordinal: Number(m[2]) } : null;
}

// ── conversation /context link → node id ────────────────────────────────────────────────────────
/**
 * Map a conversation markdown-link href that points at a `/context` file — absolute
 * `/context/<bucket>/<path>` OR bucket-relative `<bucket>/<path>` (bucket ∈ specs|generated|artifacts) — to
 * its navigator node id (`spec:`/`gen:`/`artifact:` + bucket-relative path), or null when it isn't a context
 * link (unknown bucket, missing path, or a `..` traversal). This is the conversation-side analogue of
 * {@link contextNodeForLink} (which resolves links relative to a "current file"); here the href already
 * carries its own bucket, so there is no `fromPath`.
 */
export function contextConvoNodeForHref(href: string): string | null {
  const clean = href
    .split(/[?#]/)[0]
    .replace(/^\/context\//, "")
    .replace(/^\//, "");
  const [bucket, ...rest] = clean.split("/");
  const prefix =
    bucket === "specs"
      ? "spec:"
      : bucket === "generated"
        ? "gen:"
        : bucket === "artifacts"
          ? "artifact:"
          : null;
  if (!prefix || rest.length === 0 || rest.some((s) => s === "" || s === ".."))
    return null;
  return prefix + rest.join("/");
}

// ── transcript lane for a node (null = not a transcript-backed node) ────────────────────────────
/**
 * The live/durable lane a transcript-backed node renders on — the ONE place that maps a node id to its
 * `TranscriptView` lane. Returns `null` for non-transcript nodes (files/plan/decision/ports/…), which have
 * their own view components. `jobId` is needed for the job-scoped Codex/fix lanes; `job` locates a step's
 * owning thread.
 */
export function nodeLane(
  node: string,
  jobId: string,
  job: PipelineJob | null,
): string | null {
  if (node.startsWith("codex-review:")) return codexReviewLane(jobId);
  if (!job) return null;
  // A review CHILD thread (review_lens / post_review) → the lane the backend already computed for it
  // (`autofix:<parentId>:<lensId>` / `autofix:<parentId>:fix`), carried on the pipeline data.
  for (const s of job.threads) {
    const child = (s.children ?? []).find((c) => c.id === node);
    if (child) return child.lane;
  }
  // A per-Leg node → its owning thread's stable lane (the transcript is sliced to the Leg downstream).
  const legRef = parseLegNode(node);
  if (legRef) {
    const t = job.threads.find((s) => s.id === legRef.threadId);
    return t ? threadLane(t.id) : null;
  }
  // A bare thread id → its stable thread lane.
  const thread = job.threads.find((s) => s.id === node);
  if (thread) return threadLane(thread.id);
  // A bare step id → its owning thread's lane (the transcript is filtered to the step's anchor downstream).
  const owning = job.threads.find((s) => s.steps.some((p) => p.id === node));
  if (owning) return threadLane(owning.id);
  return null;
}
