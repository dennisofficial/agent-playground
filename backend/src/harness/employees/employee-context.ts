/**
 * The agnostic context the harness injects into an employee's builders (`roleContext(ctx)`,
 * `planEngine(ctx)`, `capabilities(ctx)`, …). It carries the team-wide facts an employee's prompt
 * needs but can't hold itself (the roster is the other teammates; the team frame is shared prose).
 *
 * Static today (assembled by `PersonaService` from constants + the registry), a DB row tomorrow —
 * the builder shape is the seam. Whatever it returns must be byte-stable for a given employee so the
 * chat prompt-cache breakpoint survives (see `persona.service.ts`).
 */
export interface EmployeeContext {
  /** The shared team frame (`TEAM_CONTEXT`) spliced into role knowledge. */
  team: string;
  /** One-line roster summary of the other teammates ("Alex — backend engineer; …"). */
  roster: string;
}
