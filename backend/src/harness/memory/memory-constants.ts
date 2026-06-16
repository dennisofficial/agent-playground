/**
 * Operational constants for the memory/compaction subsystem. These are stable defaults
 * that belong in code, not in the environment — they are not deployment-time knobs.
 *
 * Token counts are estimated as Math.ceil(chars / 4) — a fast, conservative proxy.
 * Real token counts may be slightly higher for JSON/code-dense turns, but the 10k
 * verbatim buffer inside a 200k context window keeps this safe.
 *
 * Three-block compaction watermarks:
 *  - VERBATIM_BUFFER_TOKENS: the "live tail" always kept verbatim (block 3 floor).
 *    Messages within this budget are never summarised away.
 *  - COMPACTION_TRIGGER_TOKENS: when block 3 (verbatim tail, from summarizedUpTo to
 *    the end) exceeds this, compaction fires and folds the surplus into a new summary.
 *    The distance (20k − 10k = 10k) is the compaction window per pass.
 *
 * Summary queue (block 2):
 *  - MAX_SUMMARIES: maximum rolling summaries retained (FIFO; oldest dropped when exceeded).
 *  - MAX_SUMMARY_TOKENS: soft token cap per summary (~MAX_SUMMARY_TOKENS*4 chars).
 *    The prompt instructs the model; a hard backstop truncates with an ellipsis if exceeded.
 *
 * CONSOLIDATION_CRON: schedule for the nightly memory-consolidation job. Standard cron
 * expression — daily at 02:00 UTC, a low-traffic window.
 */
export const COMPACTION_TRIGGER_TOKENS = 20_000;
export const VERBATIM_BUFFER_TOKENS = 10_000;
export const MAX_SUMMARIES = 4;
export const MAX_SUMMARY_TOKENS = 2_000;
export const CONSOLIDATION_CRON = '0 2 * * *';
