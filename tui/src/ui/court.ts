import { EAttentionCourt } from "../domain/attention.js";
import { theme } from "./theme.js";

/**
 * Whose court, as a palette KEY. One table, shared by every list that draws a row — a project, a job
 * and a thread all mean the same thing by amber, and three copies of this map would eventually not.
 *
 * Names rather than colours, which is what lets the table stay at module scope. It used to hold the
 * hexes, and that made it a snapshot of the palette taken at import: correct exactly once, and
 * frozen ever after. A theme change would have repainted every list row except its court dot.
 */
const COURT_KEY: Record<EAttentionCourt, keyof typeof theme.court> = {
  [EAttentionCourt.agent]: "agent",
  [EAttentionCourt.yours]: "yours",
  [EAttentionCourt.external]: "external",
  [EAttentionCourt.none]: "none",
};

export function courtColour(court: EAttentionCourt): string {
  return theme.court[COURT_KEY[court]];
}
