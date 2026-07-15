import { describe, expect, it, vi } from 'vitest';
import { dispatchToolRequest } from './tool-bridge-host';
import type { ToolBridgeOptions, ToolRequestFrame } from './engine.types';

describe('dispatchToolRequest — the handler receives the flat payload', () => {
  const frame = (args: unknown): ToolRequestFrame =>
    ({ t: 'tool_request', id: 'x', name: 'report_verification', args } as unknown as ToolRequestFrame);

  it('hands the flat, strict-validated verdict to the handler unchanged', async () => {
    const impl = vi.fn(async () => ({ ok: true }));
    const bridge: ToolBridgeOptions = { jobId: 'j1', tools: { report_verification: impl } };
    const reply = await dispatchToolRequest(bridge, frame({ passed: true }));
    expect(impl).toHaveBeenCalledWith({ passed: true });
    expect(reply).toMatchObject({ t: 'tool_response', result: { ok: true } });
  });

  it('coerces a missing/undefined payload to an empty object', async () => {
    const impl = vi.fn(async () => ({ ok: true }));
    const bridge: ToolBridgeOptions = { jobId: 'j1', tools: { report_verification: impl } };
    await dispatchToolRequest(bridge, frame(undefined));
    expect(impl).toHaveBeenCalledWith({});
  });

  it('still enforces thread scope defensively when a `jobId` slips through', async () => {
    const impl = vi.fn(async () => ({ ok: true }));
    const bridge: ToolBridgeOptions = { jobId: 'j1', tools: { report_verification: impl } };
    const reply = await dispatchToolRequest(bridge, frame({ jobId: 'other', passed: true }));
    expect(impl).not.toHaveBeenCalled();
    expect(reply).toMatchObject({ t: 'tool_error' });
  });

  it('EXEMPTS the repo-level atlas-prod tools from the scope guard (a foreign jobId is dispatched, not denied)', async () => {
    const impl = vi.fn(async () => ({ ok: true }));
    const bridge: ToolBridgeOptions = { jobId: 'j1', tools: { atlas_job_overview: impl } };
    const foreign: ToolRequestFrame = {
      t: 'tool_request',
      id: 'x',
      name: 'atlas_job_overview',
      args: { jobId: 'another-job-in-the-repo' },
    } as unknown as ToolRequestFrame;
    const reply = await dispatchToolRequest(bridge, foreign);
    expect(impl).toHaveBeenCalledWith({ jobId: 'another-job-in-the-repo' });
    expect(reply).toMatchObject({ t: 'tool_response', result: { ok: true } });
  });
});

describe('dispatchToolRequest — a thrown error is NEVER serialised as an empty message', () => {
  const frame = (): ToolRequestFrame =>
    ({ t: 'tool_request', id: 'x', name: 'get_pipeline_state', args: {} } as unknown as ToolRequestFrame);

  it('falls back to the error NAME when a thrown Error has an empty message (the prod `Error:` bug)', async () => {
    const bridge: ToolBridgeOptions = {
      jobId: 'j1',
      tools: {
        get_pipeline_state: async () => {
          const e = new Error('');
          e.name = 'QueryFailedError';
          throw e;
        },
      },
    };
    const reply = (await dispatchToolRequest(bridge, frame())) as { t: string; message: string };
    expect(reply.t).toBe('tool_error');
    expect(reply.message).toBeTruthy();
    expect(reply.message).toContain('QueryFailedError');
  });

  it('is total against a bare thrown string (`throw \'\'`) → still non-empty', async () => {
    const bridge: ToolBridgeOptions = {
      jobId: 'j1',
      // eslint-disable-next-line @typescript-eslint/only-throw-error
      tools: { get_pipeline_state: async () => { throw ''; } },
    };
    const reply = (await dispatchToolRequest(bridge, frame())) as { t: string; message: string };
    expect(reply.t).toBe('tool_error');
    expect(reply.message.length).toBeGreaterThan(0);
  });

  it('passes a REAL message through unchanged (no regression for informative errors)', async () => {
    const bridge: ToolBridgeOptions = {
      jobId: 'j1',
      tools: { get_pipeline_state: async () => { throw new Error('boom'); } },
    };
    const reply = (await dispatchToolRequest(bridge, frame())) as { t: string; message: string };
    expect(reply.message).toBe('boom');
  });

  it('routes the FULL detail (tool name + jobId + stack) to the host `onToolError` sink', async () => {
    const onToolError = vi.fn();
    const bridge: ToolBridgeOptions = {
      jobId: 'job-42',
      tools: { get_pipeline_state: async () => { throw new Error('boom'); } },
      onToolError,
    };
    await dispatchToolRequest(bridge, frame());
    expect(onToolError).toHaveBeenCalledTimes(1);
    const line = onToolError.mock.calls[0][0] as string;
    expect(line).toContain('get_pipeline_state');
    expect(line).toContain('job-42');
    expect(line).toContain('boom');
  });
});
