import { describe, expect, it, vi } from 'vitest';
import { dispatchToolRequest, unwrapBridgeArgs } from './tool-bridge-host';
import type { ToolBridgeOptions, ToolRequestFrame } from './engine.types';

describe('unwrapBridgeArgs — normalises the model’s `{ args }` mis-nesting', () => {
  it('passes a clean payload through untouched', () => {
    expect(unwrapBridgeArgs({ passed: true, remaining: [] })).toEqual({ passed: true, remaining: [] });
  });

  it('peels a single lone-`args` wrapper', () => {
    expect(unwrapBridgeArgs({ args: { passed: true } })).toEqual({ passed: true });
  });

  it('peels the DOUBLE wrapper the model actually emits (job b30616d2)', () => {
    expect(unwrapBridgeArgs({ args: { args: { passed: true } } })).toEqual({ passed: true });
  });

  it('JSON-parses a stringified payload, then peels', () => {
    expect(unwrapBridgeArgs({ args: '{"args": {"passed": true}}' })).toEqual({ passed: true });
    expect(unwrapBridgeArgs('{"passed": true}')).toEqual({ passed: true });
  });

  it('never over-unwraps a real payload whose keys go beyond a lone `args`', () => {
    // `args` present but alongside other keys → it's the real payload, keep it.
    expect(unwrapBridgeArgs({ args: 1, passed: true })).toEqual({ args: 1, passed: true });
  });

  it('is total: junk / arrays / non-JSON strings collapse to {}', () => {
    expect(unwrapBridgeArgs(undefined)).toEqual({});
    expect(unwrapBridgeArgs(null)).toEqual({});
    expect(unwrapBridgeArgs([1, 2])).toEqual({});
    expect(unwrapBridgeArgs('not json')).toEqual({});
  });
});

describe('dispatchToolRequest — the handler receives the normalised payload', () => {
  const frame = (args: unknown): ToolRequestFrame =>
    ({ t: 'tool_request', id: 'x', name: 'report_verification', args } as unknown as ToolRequestFrame);

  it('hands the DOUBLE-wrapped verdict to the handler as `{ passed: true }`', async () => {
    const impl = vi.fn(async () => ({ ok: true }));
    const bridge: ToolBridgeOptions = { jobId: 'j1', tools: { report_verification: impl } };
    const reply = await dispatchToolRequest(bridge, frame({ args: { args: { passed: true } } }));
    expect(impl).toHaveBeenCalledWith({ passed: true });
    expect(reply).toMatchObject({ t: 'tool_response', result: { ok: true } });
  });

  it('still enforces thread scope on the normalised `jobId`', async () => {
    const impl = vi.fn(async () => ({ ok: true }));
    const bridge: ToolBridgeOptions = { jobId: 'j1', tools: { report_verification: impl } };
    const reply = await dispatchToolRequest(bridge, frame({ args: { jobId: 'other', passed: true } }));
    expect(impl).not.toHaveBeenCalled();
    expect(reply).toMatchObject({ t: 'tool_error' });
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
