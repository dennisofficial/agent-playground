import type { EngineUsage } from '@shared/engine';
import { describe, expect, it, vi } from 'vitest';
import type { AppVersionService } from '../../cluster/app-version.service';
import { TurnUsageProjector } from '../turn-usage-projector.service';

function make() {
  const stats = {
    create: vi.fn((x) => x),
    save: vi.fn(async (x) => ({ ...x, id: 'stat-1' })),
  };
  const modelUsage = { create: vi.fn((x) => x), save: vi.fn(async (x) => x) };
  const jobs = { findOne: vi.fn(async () => ({ org_id: 'org-resolved' })) };
  const version = { sha: 'sha-abc1234' } as unknown as AppVersionService;
  const projector = new TurnUsageProjector(
    stats as never,
    modelUsage as never,
    jobs as never,
    version,
  );
  return { projector, stats, modelUsage, jobs, version };
}

const usage: EngineUsage = {
  inputTokens: 1000,
  outputTokens: 200,
  cacheReadTokens: 5000,
  cacheWriteTokens: 300,
  costUsd: 1.23,
  model: 'claude-opus-4-8',
  contextTokens: 800,
  contextModel: 'claude-opus-4-8',
  modelUsage: {
    'claude-opus-4-8': {
      inputTokens: 10,
      outputTokens: 150,
      cacheReadTokens: 4000,
      cacheWriteTokens: 300,
      costUsd: 1.0,
    },
    'claude-sonnet-5': {
      inputTokens: 5,
      outputTokens: 50,
      cacheReadTokens: 1000,
      cacheWriteTokens: 0,
      costUsd: 0.23,
      webSearchRequests: 2,
    },
  },
};

describe('TurnUsageProjector', () => {
  it('writes one turn_stats + one turn_model_usage row per model, with lane/step/tags attribution', async () => {
    const { projector, stats, modelUsage } = make();
    await projector.record(
      {
        jobId: 'job-1',
        orgId: 'org-1',
        lane: 'thread:th-1',
        kind: 'step',
        engine: 'claude',
        credentialId: 'cred-1',
        metaTag: { phaseId: 'st-1', batchOrdinal: 2 },
      },
      usage,
    );

    expect(stats.save).toHaveBeenCalledOnce();
    const stat = stats.save.mock.calls[0][0];
    expect(stat).toMatchObject({
      org_id: 'org-1',
      job_id: 'job-1',
      thread_id: 'th-1', // parsed from lane
      step_id: 'st-1', // lifted from metaTag.phaseId
      kind: 'step',
      engine: 'claude',
      credential_id: 'cred-1',
      engine_git_sha: 'sha-abc1234',
      model: 'claude-opus-4-8',
      input_tokens: 1000,
      output_tokens: 200,
      cache_read_tokens: 5000,
      cache_write_tokens: 300,
      cost_usd: 1.23,
      context_tokens: 800,
      tags: { batchOrdinal: 2 }, // phaseId removed (→ step_id), the rest kept
    });
    expect(stat.context_limit).toBe(1_000_000); // resolved from the opus context model
    expect(stat.raw).toBe(usage);

    expect(modelUsage.save).toHaveBeenCalledOnce();
    const rows = modelUsage.save.mock.calls[0][0] as Array<Record<string, unknown>>;
    expect(rows).toHaveLength(2);
    const opus = rows.find((r) => r.model === 'claude-opus-4-8');
    const sonnet = rows.find((r) => r.model === 'claude-sonnet-5');
    expect(opus).toMatchObject({
      turn_stats_id: 'stat-1',
      job_id: 'job-1',
      org_id: 'org-1',
      output_tokens: 150,
      cache_read_tokens: 4000,
      cost_usd: 1.0,
      web_search_requests: 0,
    });
    expect(sonnet).toMatchObject({
      model: 'claude-sonnet-5',
      cost_usd: 0.23,
      web_search_requests: 2,
    });
  });

  it('resolves org_id from job_id when the caller has no orgId (autofix path)', async () => {
    const { projector, stats, jobs } = make();
    await projector.record(
      {
        jobId: 'job-9',
        lane: 'autofix:af-1',
        kind: 'autofix',
        engine: 'claude',
      },
      usage,
    );
    expect(jobs.findOne).toHaveBeenCalledOnce();
    expect(stats.save.mock.calls[0][0]).toMatchObject({
      org_id: 'org-resolved',
      thread_id: null,
    });
  });

  it('is a no-op when usage is undefined', async () => {
    const { projector, stats, modelUsage } = make();
    await projector.record(
      { jobId: 'j', lane: 'main', kind: 'brain', engine: 'claude' },
      undefined,
    );
    expect(stats.save).not.toHaveBeenCalled();
    expect(modelUsage.save).not.toHaveBeenCalled();
  });

  it('writes turn_stats with no model rows when the engine reported no modelUsage (Codex)', async () => {
    const { projector, stats, modelUsage } = make();
    await projector.record(
      {
        jobId: 'j',
        orgId: 'o',
        lane: 'thread:t',
        kind: 'review',
        engine: 'codex',
      },
      { inputTokens: 10, outputTokens: 5 },
    );
    expect(stats.save).toHaveBeenCalledOnce();
    expect(modelUsage.save).not.toHaveBeenCalled();
  });

  it('stamps engine_git_sha on every row but leaves credential_id null when the caller has none (Codex/d3)', async () => {
    const { projector, stats } = make();
    await projector.record(
      {
        jobId: 'j',
        orgId: 'o',
        lane: 'thread:t',
        kind: 'review',
        engine: 'codex',
      },
      { inputTokens: 10, outputTokens: 5 },
    );
    expect(stats.save.mock.calls[0][0]).toMatchObject({
      credential_id: null,
      engine_git_sha: 'sha-abc1234',
    });
  });
});
