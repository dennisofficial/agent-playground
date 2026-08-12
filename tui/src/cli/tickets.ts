/**
 * `context/charting/` holds a job's map and its ticket files. A ticket is a FILE, never a row — the
 * ticket set is discovered, re-scoped and ruled out of scope constantly during charting, and rows
 * would need reconciling with files on every resolution. So finding ticket 3 is a filename question,
 * and it is pure.
 */

export const MAP_FILE = 'map.md';

/** `NN-<slug>.md`. The NUMBER is the ticket's identity — what Dennis says out loud ("work 03"), what
 *  the map links, and what a thread's brief points at. The slug is a human label. */
const TICKET_FILE = /^(\d+)-(.+)\.md$/;

export type TicketFile = { fileName: string; number: number; slug: string };

export function readTicketFiles(fileNames: readonly string[]): TicketFile[] {
  return fileNames
    .map((fileName) => {
      const match = TICKET_FILE.exec(fileName);
      if (!match) return null;
      const [, digits, slug] = match;
      if (digits === undefined || slug === undefined) return null;
      return { fileName, number: Number(digits), slug };
    })
    .filter((ticket): ticket is TicketFile => ticket !== null)
    .sort((a, b) => a.number - b.number);
}

/**
 * Every file claiming the number, not the first — `03-foo.md` and `3-bar.md` are the same ticket by
 * identity, and silently picking one would hand the agent a document its map does not link.
 */
export function matchTicket(args: {
  fileNames: readonly string[];
  ticketNumber: number;
}): TicketFile[] {
  return readTicketFiles(args.fileNames).filter((ticket) => ticket.number === args.ticketNumber);
}

/** What a miss prints instead of "not found": the numbers that DO exist are the useful half. */
export function ticketIndex(fileNames: readonly string[]): string[] {
  return readTicketFiles(fileNames).map((ticket) => `  ${ticket.number}  ${ticket.slug}`);
}
