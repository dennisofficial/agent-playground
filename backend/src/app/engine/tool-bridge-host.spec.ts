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
