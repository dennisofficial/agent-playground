import { EAttentionCourt } from "../domain/attention.js";
import { theme } from "./theme.js";

/**
 * Whose court, as a colour. One table, shared by every list that draws a row — a project, a job and
 * a thread all mean the same thing by amber, and three copies of this map would eventually not.
 */
const COURT_COLOURS: Record<EAttentionCourt, string> = {
  [EAttentionCourt.agent]: theme.court.agent,
  [EAttentionCourt.yours]: theme.court.yours,
  [EAttentionCourt.external]: theme.court.external,
  [EAttentionCourt.none]: theme.court.none,
};

export function courtColour(court: EAttentionCourt): string {
  return COURT_COLOURS[court];
}
