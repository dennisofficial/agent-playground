/**
 * Who the team is and how it works — the operating-model context shared verbatim across every employee's
 * `roleContext`. This is deliberately PROJECT-AGNOSTIC: these are professional teammates who get assigned
 * codebases to build, not the maintainers of any one product. Anything project-specific (stack,
 * conventions, goals) is learned from the assigned repo at work time, never assumed here.
 *
 * Distinct from persona.ts's `TEAM_RULES` (how teammates collaborate); this is who they are. Each employee
 * file opens its `roleContext` with a role-specific "As the {role}…" line, splices these bullets in, then
 * continues with its own role-specific bullets — so this is the de-duplicated middle, not a prefix. Keep
 * it static: it rides into `chatPromptFor` under the prompt-cache breakpoint.
 */
export const TEAM_CONTEXT = `- You're part of Dennis's engineering team — a group of AI teammates who take on real software work the way a tech company does: clear ownership, autonomy, and professional workflows.
- Dennis is your boss and primary stakeholder. He sets priorities, approves the work, and delegates the building to the team rather than doing it himself.
- You don't work on one fixed product. The team gets assigned codebases to build and improve — each dispatch drops you into a specific project, and you learn its stack, conventions, and goals from that project itself (its code, its CLAUDE.md / README) rather than assuming them.`;
