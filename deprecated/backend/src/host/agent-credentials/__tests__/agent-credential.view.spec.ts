import type { AccountUsageSnapshot } from '@workspace/shared';
import { AgentCredentialViewService } from '../agent-credential-view.service';

const view = new AgentCredentialViewService();
const planLabel = (s: string | null) => view.planLabel(s);
const snapshotToUsage = (s: AccountUsageSnapshot | null) => view.snapshotToUsage(s);

describe('planLabel', () => {
  it('title-cases and appends "plan"', () => {
    expect(planLabel('max')).toBe('Max plan');
  });
  it('does not double up when the value already says plan', () => {
    expect(planLabel('pro plan')).toBe('Pro plan');
  });
  it('returns null for empty/nullish', () => {
    expect(planLabel(null)).toBeNull();
    expect(planLabel('  ')).toBeNull();
  });
});

describe('snapshotToUsage', () => {
  const future = new Date(Date.now() + 3_600_000).toISOString();
  const past = new Date(Date.now() - 3_600_000).toISOString();

  it('returns null when there is no snapshot', () => {
    expect(snapshotToUsage(null)).toBeNull();
  });

  it('surfaces a live window and marks ok', () => {
    const snap: AccountUsageSnapshot = {
      windows: { fiveHour: { utilization: 40, resetsAt: future } },
      fetchedAt: Date.now(),
      source: 'harvested',
    };
    const usage = snapshotToUsage(snap)!;
    expect(usage.fiveHour).toEqual({ utilization: 40, resetsAt: future });
    expect(usage.ok).toBe(true);
    expect(usage.source).toBe('harvested');
  });

  it('drops a window past its reset and degrades to stale when nothing is live', () => {
    const snap: AccountUsageSnapshot = {
      windows: { fiveHour: { utilization: 90, resetsAt: past } },
      fetchedAt: Date.now(),
      source: 'usage_api',
    };
    const usage = snapshotToUsage(snap)!;
    expect(usage.fiveHour).toBeNull();
    expect(usage.ok).toBe(false);
    expect(usage.source).toBe('stale');
  });

  it('treats a non-empty modelWindows as live even without flat windows', () => {
    const snap: AccountUsageSnapshot = {
      windows: {},
      modelWindows: [{ label: 'Fable', utilization: 10, resetsAt: null }],
      fetchedAt: Date.now(),
      source: 'usage_api',
    };
    const usage = snapshotToUsage(snap)!;
    expect(usage.ok).toBe(true);
    expect(usage.modelWindows).toHaveLength(1);
  });
});
