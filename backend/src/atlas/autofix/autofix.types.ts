/**
 * W7 — the AUTO-FIX STAGE domain types (clean-room, Atlas v2). A fan-out of parallel read-only review
 * passes over a section's (or the whole feature's) diff → aggregate + dedupe findings → one execute
 * turn that applies the fixes → a git commit. Two entry points share the core: per-section (after a
 * section's phases) and PR-tail (over the whole accumulated diff before the human reviews the PR).
 *
 * These shapes live in THIS subfolder, never `domain/index.ts`. Zero imports from `harness/**` or the
 * v1 `slack-app` surface — the stage talks only to W1's `EngineRunner` + `LocalGitService`.
 */
import type { EngineAuth } from '../engine';
import type { SessionEngine } from '../domain';

/** How severe a finding is — drives whether the fix turn is even attempted (see `fixMinSeverity`). */
export type FindingSeverity = 'low' | 'medium' | 'high';

/** A single review finding from one lens pass. The `lens` + `file` tags drive dedupe. */
export interface ReviewFinding {
  /** Which lens surfaced it (best_practices | correctness | consistency | …). */
  lens: string;
  severity: FindingSeverity;
  /** The file the finding is about, repo-relative when the lens names one (else null = cross-cutting). */
  file: string | null;
  /** A one-line title — the dedupe key alongside `file`. */
  title: string;
  /** The full description: what's wrong + the suggested fix. */
  detail: string;
}

/**
 * A review LENS — one read-only pass with its own focus. Each lens is a vanilla `EngineRunner` review
 * turn over the diff that returns structured findings. Lenses are data so the fan-out width is just the
 * length of the selected list (configurable). `id` is stable (tags the findings + dedupe).
 */
export interface ReviewLens {
  id: string;
  /** Human label for logs/summaries. */
  label: string;
  /** The lens-specific framing injected into the review prompt (what this pass is looking for). */
  focus: string;
}

/** A commit the stage produced (a fix commit). */
export interface AutoFixCommit {
  sha: string;
  message: string;
}

/** What one fan-out + fix pass produced — the structured summary the driver records/relays. */
export interface AutoFixSummary {
  /** 'section' (after a section's phases) or 'pull_request' (PR-tail over the whole diff). */
  mode: 'section' | 'pull_request';
  /** The lens ids that actually ran. */
  lensesRun: string[];
  /** Every finding, post-aggregation + dedupe (across lenses). */
  findings: ReviewFinding[];
  /** True when a fix turn ran (findings ≥ `fixMinSeverity` existed AND `applyFixes` was on). */
  fixesAttempted: boolean;
  /** A short prose note from the fix turn about what it changed (empty when no fix turn ran). */
  fixReport: string;
  /** The commit(s) the fix turn produced — empty when the fix turn changed nothing. */
  commits: AutoFixCommit[];
  /** True when the fan-out found nothing actionable (a clean pass — idempotent re-runs land here). */
  clean: boolean;
}

/**
 * Tunable knobs for one auto-fix run. Every field is OPTIONAL — the stage applies conservative
 * defaults (see DEFAULT_AUTOFIX_OPTIONS), so the driver can call `autofixSection(ctx)` with no opts.
 * The orchestrator can also surface these as env later; W7 keeps them as options to avoid editing
 * `validation.ts`.
 */
export interface AutoFixOptions {
  /**
   * Which lenses to fan out over. Defaults to the built-in DEFAULT_LENSES. Width = this list's length;
   * pass a subset for a narrower (cheaper) pass or extend with custom lenses.
   */
  lenses?: ReviewLens[];
  /**
   * Cap on parallel review passes in flight at once (the engine + API are the bottleneck). Defaults to
   * running all selected lenses concurrently when ≤ this cap, else in capped batches.
   */
  concurrency?: number;
  /**
   * Whether to actually APPLY fixes (run the execute turn + commit) or stop after review (report-only).
   * Default true. Report-only is the conservative dry-run for validation.
   */
  applyFixes?: boolean;
  /**
   * The minimum severity a finding must hit for the fix turn to be attempted at all. Default 'medium'
   * — low-severity nits don't earn a write turn. Findings below it still appear in the summary.
   */
  fixMinSeverity?: FindingSeverity;
  /** Which engine backs the review + fix turns. Default 'claude'. */
  engine?: SessionEngine;
  /** Model override for the turns (else the EngineRunner's env default). */
  model?: string;
  /** Auth override for the turns (else derived from env by the EngineRunner). */
  auth?: EngineAuth;
}

/**
 * The CONTEXT one auto-fix run needs: the worktree to review/fix inside, the change set, and light
 * framing (what the work was meant to do). The change set is supplied as a unified `diff` and/or the
 * list of `changedFiles`; the stage prefers an explicit diff but can derive one from git when absent.
 */
export interface AutoFixContext {
  /** Absolute path to the feature worktree (the engine cwd + the commit target). */
  worktreePath: string;
  /**
   * Stable per-feature key namespacing the engine's isolated home + Codex client cache. Use the same
   * `<projectId>--<branch>` key the turn-runner uses so the auto-fix turns share the feature's home.
   */
  sandboxKey: string;
  /**
   * The unified diff to review. When omitted the stage derives one from the worktree git state (see
   * `gitRange`). Supplying it is cheaper + deterministic (the driver already has the section's diff).
   */
  diff?: string;
  /** The repo-relative changed files (review framing + scopes the fix). Optional alongside `diff`. */
  changedFiles?: string[];
  /**
   * When `diff` is absent, the git range the stage diffs to build one (e.g. `origin/main...HEAD` for a
   * PR-tail pass, or a section's start sha `..HEAD`). Defaults to the worktree's full uncommitted +
   * committed delta against the merge-base when unset (the stage falls back to `git diff HEAD`).
   */
  gitRange?: string;
  /**
   * Light context: what the section / feature was meant to do (the section brief + decision-record
   * overview, or the bugfix intent). Grounds the review so lenses judge against intent, not vacuum.
   */
  intent: string;
  /** Optional label for logs/commit messages (e.g. the section brief or "PR-tail"). */
  label?: string;
  /**
   * Docker mode: the sandbox CONTAINER the review/fix turns exec into (threaded from the driver's
   * sandbox). Absent → host-local execution. `execUser` is the uid:gid to exec as (host-uid).
   */
  containerId?: string;
  execUser?: string;
}
