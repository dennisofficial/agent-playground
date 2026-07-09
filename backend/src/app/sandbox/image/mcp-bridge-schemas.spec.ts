import { describe, expect, it } from 'vitest';
import { TOOL_SCHEMAS } from './mcp-bridge-schemas';

describe('mcp-bridge-schemas — TOOL_SCHEMAS descriptions (golden baseline)', () => {
  it('carries a description for every declared tool', async () => {
    const descriptions = Object.fromEntries(
      Object.entries(TOOL_SCHEMAS).map(([name, schema]) => [name, schema.description]),
    );
    expect(Object.keys(descriptions)).toEqual([
      'report_verification',
      'complete_thread',
      'block_thread',
      'reset_sandbox',
      'task_create',
      'task_update',
    ]);
    const rendered = Object.entries(descriptions)
      .map(([name, description]) => `## ${name}\n${description}`)
      .join('\n\n');
    await expect(rendered).toMatchFileSnapshot('./__snapshots__/tool-schema-descriptions.txt');
  });
});
