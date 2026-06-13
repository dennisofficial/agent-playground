/**
 * Operational constants for the memory/compaction subsystem. These are stable defaults
 * that belong in code, not in the environment — they are not deployment-time knobs.
 *
 * COMPACTION_THRESHOLD: new messages since the last compaction pass that trigger a new
 * summary (the compaction window = messages above the watermark).
 *
 * COMPACTION_TAIL: verbatim messages kept after compaction (the "live" tail the model
 * sees directly, without going through the summary).
 *
 * CONSOLIDATION_CRON: schedule for the nightly memory-consolidation job. Standard cron
 * expression — daily at 02:00 UTC, a low-traffic window.
 */
export const COMPACTION_THRESHOLD = 50;
export const COMPACTION_TAIL = 20;
export const CONSOLIDATION_CRON = '0 2 * * *';
