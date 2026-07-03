/**
 * prompt-kit — the ONE home for Atlas's system prompts.
 *
 * - `fragments.ts` — reusable fragment TEXT (shared framing + the three behavioral notes).
 * - `layers.ts`    — which fragments belong to which audience bucket.
 * - `job-kind.ts`  — the job-type dimension (feature | bugfix | onboarding | event).
 * - `compose.ts`   — `buildSystemPrompt` composer + `PromptAudience`.
 * - `bodies/`      — the relocated role bodies (brain / worker / planner / ship / autofix / subagents / meta).
 * - `registry.ts`  — id → composed-prompt thunk, for the dev-only preview endpoint.
 *
 * prompt-kit is a PURE library (no NestJS DI): consumers import the composed prompts directly.
 */
export * from './fragments';
export * from './layers';
export * from './job-kind';
export * from './compose';
// Relocated bodies are imported by DIRECT path (`./bodies/<x>.body`) by their consumers to keep the
// barrel free of cross-file edit contention; `registry.ts` re-exports the ones the preview endpoint needs.
export * from './registry';
