/**
 * prompt-kit / jit — the background-task cap notice (content for the `bg-task-cap` JIT rule).
 *
 * Relocated verbatim out of `engine/engine.types.ts` so the payload lives beside the rest of the rule catalog
 * (the hub owns CONTENT; the engine's hold-timer keeps the DELIVERY wiring and re-exports this for its callers +
 * the driver prose snapshot). Byte-identical to the shipped text — guarded by the `bg-task-cap-notice` golden
 * snapshot. Injected IN-TURN as a `steer-now` message when a `run_in_background` Bash task keeps the turn held
 * past the rule's `holdMs`; the engine then ends the SDK session (killing the still-running task), so this
 * reaches the agent in the exact context where it backgrounded the task — steering it to `atlas-svc` for any
 * genuinely long-running process. A one-time signal, not part of the byte-stable system prompt.
 */
export const BG_TASK_CAP_NOTICE = [
  '[background task capped] A Bash task you started with run_in_background was still running when this turn',
  'hit its maximum hold time, so it was ended and is NO LONGER RUNNING. run_in_background is only for SHORT,',
  'finite work (a build, a migration, a test suite) that finishes on its own. Long-running processes — dev',
  'servers, file/test watchers, headless browsers, docker compose services — belong under atlas-svc: start',
  'them with `atlas-svc run …` (supervised, survives across turns) and check them with `atlas-svc ps`. Do',
  'not rely on the capped task having completed; re-run its work under atlas-svc if you still need it.',
].join(' ');
