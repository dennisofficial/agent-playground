/**
 * Operational constants for the memory/compaction subsystem. These are stable defaults
 * that belong in code, not in the environment — they are not deployment-time knobs.
 *
 * COMPACTION_TOKEN_THRESHOLD: the gate's reported input-token count above which the
 * compaction node fires. Tracks context growth more accurately than message count
 * because a single tool-heavy turn can balloon the context as much as twenty plain turns.
 * 80 000 ≈ half of Claude's 200 k context window, giving the summary room to breathe.
 *
 * COMPACTION_TAIL: verbatim messages kept after compaction (the "live" tail the model
 * sees directly, without going through the summary).
 *
 * CONSOLIDATION_CRON: schedule for the nightly memory-consolidation job. Standard cron
 * expression — daily at 02:00 UTC, a low-traffic window.
 */
export const COMPACTION_TOKEN_THRESHOLD = 80_000;
export const COMPACTION_TAIL = 20;
export const CONSOLIDATION_CRON = '0 2 * * *';
