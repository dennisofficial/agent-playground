import { describe, expect, it } from 'vitest';
import { MemoryMetricsService } from './memory-metrics.service';

describe('MemoryMetricsService recall counters', () => {
  it('tracks attempts, hits, and injected facts', () => {
    const m = new MemoryMetricsService();
    m.recordRecall(3); // hit
    m.recordRecall(0); // empty
    m.recordRecall(1); // hit
    const { recall } = m.snapshot();
    expect(recall).toEqual({ attempts: 3, hits: 2, factsInjected: 4 });
  });

  it('snapshot is a copy and reset clears recall', () => {
    const m = new MemoryMetricsService();
    m.recordRecall(2);
    const snap = m.snapshot();
    snap.recall.attempts = 999; // mutating the copy must not touch the live counter
    expect(m.snapshot().recall.attempts).toBe(1);
    m.reset();
    expect(m.snapshot().recall).toEqual({
      attempts: 0,
      hits: 0,
      factsInjected: 0,
    });
  });
});
