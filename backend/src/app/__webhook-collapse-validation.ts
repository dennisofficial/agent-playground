// TEMPORARY throwaway file — used ONLY to force a CI failure to live-validate the GitHub
// webhook PR-state / CI fan-out collapse fix in production. Delete along with its branch/PR.
// The deliberate type error below fails `Backend typecheck` fast so one failing commit emits
// workflow_run + check_suite + check_run for the SAME head_sha.
export const DELIBERATE_CI_FAILURE: number = 'boom';
