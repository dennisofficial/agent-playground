/**
 * Per-job auto-approve MODE — the WIRE CONTRACT for how far a job advances without a human.
 * Single-sourced here (like `JOB_ACTIVITIES`) so the backend and web console can't drift.
 *
 *  - `off`   — both gates wait for a human.
 *  - `plan`  — the plan / direct-build gate auto-advances; the ship-review gate still waits.
 *  - `ship`  — the ship-review gate auto-advances; the plan gate still waits.
 *  - `both`  — both gates auto-advance (full autonomy — the pre-split boolean `true`).
 */
export const AUTO_APPROVE_MODES = ['off', 'plan', 'ship', 'both'] as const;
export type AutoApproveMode = (typeof AUTO_APPROVE_MODES)[number];

export const modeApprovesPlan = (m: AutoApproveMode): boolean => m === 'plan' || m === 'both';
export const modeApprovesShip = (m: AutoApproveMode): boolean => m === 'ship' || m === 'both';

/** True when ANY gate auto-advances — the display/"is autonomy on" helper. */
export const isAutoApproveOn = (m: AutoApproveMode): boolean => m !== 'off';

export const isAutoApproveMode = (v: unknown): v is AutoApproveMode =>
  typeof v === 'string' && (AUTO_APPROVE_MODES as readonly string[]).includes(v);
