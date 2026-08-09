import { describe, expect, it } from 'bun:test';
import { ClaudeUsageClient } from '../claude-usage.client.js';

/** Trimmed from a real `GET /api/oauth/usage` response — utilisation is stated as 0..100 here. */
const LIVE_BODY = {
  five_hour: { utilization: 20.0, resets_at: '2026-08-02T19:30:00.764178+00:00' },
  seven_day: { utilization: 7.0, resets_at: '2026-08-05T10:00:00.764198+00:00' },
  seven_day_oauth_apps: null,
  seven_day_opus: null,
  seven_day_sonnet: null,
  extra_usage: { is_enabled: false, utilization: null },
};

describe('ClaudeUsageClient', () => {
  const client = new ClaudeUsageClient();

  it('reads the two meters off a real response body', () => {
    expect(client.parse(LIVE_BODY)).toEqual({
      fiveHour: { utilization: 20, resetsAt: '2026-08-02T19:30:00.764178+00:00' },
      sevenDay: { utilization: 7, resetsAt: '2026-08-05T10:00:00.764198+00:00' },
    });
  });

  it('does NOT apply the 0..1 heuristic — this endpoint already speaks percent', () => {
    // `toPercent` would read 1.0 as a full window. Here it is one percent, and a meter that jumps
    // to 100% would trigger a rotation that was never needed.
    const parsed = client.parse({ five_hour: { utilization: 1.0, resets_at: null } });
    expect(parsed.fiveHour).toEqual({ utilization: 1, resetsAt: null });
  });

  it('shows the weekly window closest to stopping the work', () => {
    const parsed = client.parse({
      seven_day: { utilization: 7, resets_at: 'a' },
      seven_day_opus: { utilization: 62, resets_at: 'b' },
      seven_day_sonnet: { utilization: 12, resets_at: 'c' },
    });
    expect(parsed.sevenDay).toEqual({ utilization: 62, resetsAt: 'b' });
  });

  it('reports a missing window as unknown rather than as zero', () => {
    expect(client.parse({})).toEqual({ fiveHour: null, sevenDay: null });
    expect(client.parse({ five_hour: null, seven_day: { utilization: null } })).toEqual({
      fiveHour: null,
      sevenDay: null,
    });
  });
});
