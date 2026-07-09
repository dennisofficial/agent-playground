// TEMPORARY throwaway — forces a CI failure on an UNOWNED branch to live-validate route-only (d6):
// the failing CI events must be DROPPED (no-owner), NOT seed a job. Delete with its branch/PR.
export const ROUTE_ONLY_CHECK: number = 'boom';
