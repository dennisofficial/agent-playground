import { describe, expect, it } from 'bun:test';
import { matchTicket, readTicketFiles, ticketIndex } from '../tickets.js';

const FILES = ['map.md', '01-phase-vocabulary.md', '03-intake-shape.md', 'notes.txt', 'draft.md'];

describe('readTicketFiles', () => {
  it('keeps only NN-<slug>.md and orders by number, not by name', () => {
    expect(readTicketFiles(['10-later.md', '02-earlier.md'])).toEqual([
      { fileName: '02-earlier.md', number: 2, slug: 'earlier' },
      { fileName: '10-later.md', number: 10, slug: 'later' },
    ]);
  });

  it('ignores the map and anything unnumbered', () => {
    expect(readTicketFiles(FILES).map((ticket) => ticket.number)).toEqual([1, 3]);
  });
});

describe('matchTicket', () => {
  it('matches on the number, whatever the padding', () => {
    expect(matchTicket({ fileNames: FILES, ticketNumber: 3 })).toEqual([
      { fileName: '03-intake-shape.md', number: 3, slug: 'intake-shape' },
    ]);
    expect(matchTicket({ fileNames: ['3-intake.md'], ticketNumber: 3 })).toHaveLength(1);
  });

  it('returns every claimant so an ambiguous number can be reported, not silently resolved', () => {
    expect(
      matchTicket({ fileNames: ['03-one.md', '3-two.md'], ticketNumber: 3 }),
    ).toHaveLength(2);
  });

  it('is empty for a number nobody claims', () => {
    expect(matchTicket({ fileNames: FILES, ticketNumber: 9 })).toEqual([]);
  });
});

describe('ticketIndex', () => {
  it('lists the numbers that DO exist — the useful half of a miss', () => {
    expect(ticketIndex(FILES)).toEqual(['  1  phase-vocabulary', '  3  intake-shape']);
  });
});
