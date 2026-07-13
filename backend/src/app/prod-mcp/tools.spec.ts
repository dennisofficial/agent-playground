import { describe, expect, it, vi } from 'vitest';
import type { DataSource } from 'typeorm';
import { TOOL_HANDLERS, type ToolCtx } from './tools';

describe('mcp-reader tool argument validation', () => {
  it('rejects a missing jobId before querying TypeORM', async () => {
    const getRepository = vi.fn();
    const ctx: ToolCtx = {
      ds: { getRepository } as unknown as DataSource,
      roots: { agentHome: '/tmp/agent-home', repos: '/tmp/repos' },
      audit: {},
    };

    await expect(TOOL_HANDLERS.atlas_job_overview(ctx, {})).rejects.toThrow(
      'jobId is required',
    );
    expect(getRepository).not.toHaveBeenCalled();
  });

  it('rejects an invalid atlas_query format before opening a query runner', async () => {
    const createQueryRunner = vi.fn();
    const ctx: ToolCtx = {
      ds: { createQueryRunner } as unknown as DataSource,
      roots: { agentHome: '/tmp/agent-home', repos: '/tmp/repos' },
      audit: {},
    };

    await expect(
      TOOL_HANDLERS.atlas_query(ctx, {
        sql: 'SELECT 1',
        format: 'xml',
      }),
    ).rejects.toThrow('format must be one of: jsonl, csv, tsv');
    expect(createQueryRunner).not.toHaveBeenCalled();
  });

  it('rejects an invalid atlas_query limit before opening a query runner', async () => {
    const createQueryRunner = vi.fn();
    const ctx: ToolCtx = {
      ds: { createQueryRunner } as unknown as DataSource,
      roots: { agentHome: '/tmp/agent-home', repos: '/tmp/repos' },
      audit: {},
    };

    await expect(
      TOOL_HANDLERS.atlas_query(ctx, {
        sql: 'SELECT 1',
        limit: '5000',
      }),
    ).rejects.toThrow('limit must be a finite number');
    expect(createQueryRunner).not.toHaveBeenCalled();
  });
});
