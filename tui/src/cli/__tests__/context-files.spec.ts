import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readMap, readTicket } from '../context-files.js';

describe('context files', () => {
  let chartingDir: string;

  beforeEach(() => {
    chartingDir = mkdtempSync(join(tmpdir(), 'atlas-charting-'));
  });

  afterEach(() => {
    rmSync(chartingDir, { recursive: true, force: true });
  });

  it('prints the map with its absolute path first, so the follow-up Edit needs no guessing', () => {
    writeFileSync(join(chartingDir, 'map.md'), '# Map\n\n## Destination\n\nship it\n');

    const result = readMap(chartingDir);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.text.startsWith(join(chartingDir, 'map.md'))).toBe(true);
    expect(result.text).toContain('## Destination');
  });

  it('says who writes the map when there is none, rather than failing', () => {
    const result = readMap(chartingDir);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.message).toContain('charting writes it to');
    expect(result.message).toContain('map.md');
  });

  it('reads a ticket by its number', () => {
    writeFileSync(join(chartingDir, '03-charting-shape.md'), '# 03 — charting shape\n');

    const result = readTicket({ chartingDir, ticketNumber: 3 });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.text).toContain('# 03 — charting shape');
  });

  it('lists the tickets that exist when the number misses', () => {
    writeFileSync(join(chartingDir, '01-first.md'), 'x');
    writeFileSync(join(chartingDir, '02-second.md'), 'y');

    const result = readTicket({ chartingDir, ticketNumber: 7 });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.message).toContain('no ticket 7');
    expect(result.message).toContain('1  first');
    expect(result.message).toContain('2  second');
  });

  it('reports an empty charting folder as empty, not as a broken read', () => {
    const result = readTicket({ chartingDir, ticketNumber: 1 });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.message).toContain('no ticket files in');
  });

  it('refuses an ambiguous number instead of picking one', () => {
    writeFileSync(join(chartingDir, '03-one.md'), 'x');
    writeFileSync(join(chartingDir, '3-two.md'), 'y');

    const result = readTicket({ chartingDir, ticketNumber: 3 });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.message).toContain('ambiguous');
  });

  it('treats a missing folder as an empty one — a job may never have run charting', () => {
    const result = readMap(join(chartingDir, 'nope'));
    expect(result.ok).toBe(false);
  });
});
