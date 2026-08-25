import { testRender } from '@opentui/react/test-utils';
import { describe, expect, it } from 'bun:test';
import React from 'react';
import type { Delegate } from '../../domain/delegates.js';
import { EDelegateStatus, type Message } from '../../domain/message.js';
import { EMessageType } from '../../generated/prisma/enums.js';
import { MessageView } from '../components/message-view.js';
import { SPINNER_FRAMES } from '../theme.js';

/**
 * Running and finished must not look the same.
 *
 * They did: two Agent blocks side by side, both dim, both reading `54 tools · 8m 24s`, and the only
 * thing separating the one still working from the one that had already answered was whether a result
 * line happened to be underneath it. Mounted for real because the fix is entirely a rendering
 * decision — nothing in the types or the domain can tell you the two frames differ.
 */

const WIDTH = 90;
const HEIGHT = 8;
const NOW = 1_000_000;

const CALL: Message = {
  id: 'm-1',
  payload: {
    type: EMessageType.tool_call,
    toolUseId: 'toolu_parent',
    name: 'Agent',
    input: { description: 'Adversarial review', subagent_type: 'general-purpose' },
  },
} as unknown as Message;

function delegate(status: EDelegateStatus): Delegate {
  return {
    taskId: 'task-1',
    toolUseId: 'toolu_parent',
    agentType: 'general-purpose',
    taskType: 'local_agent',
    description: 'Adversarial review',
    background: false,
    status,
    toolUses: 54,
    lastTool: 'Bash',
    startedAt: NOW - 504_000,
    ...(status === EDelegateStatus.running ? {} : { endedAt: NOW }),
  };
}

async function frameFor(status: EDelegateStatus): Promise<string> {
  const setup = await testRender(
    <box flexDirection="column" width={WIDTH} height={HEIGHT}>
      <MessageView
        message={CALL}
        delegates={[delegate(status)]}
        now={NOW}
        width={WIDTH}
      />
    </box>,
    { width: WIDTH, height: HEIGHT },
  );
  try {
    await setup.flush();
    return setup.captureCharFrame();
  } finally {
    setup.renderer.destroy?.();
  }
}

describe('a delegate under the call that spawned it', () => {
  it('marks a running one with the spinner the working line uses', async () => {
    const frame = await frameFor(EDelegateStatus.running);
    expect(SPINNER_FRAMES.some((glyph) => frame.includes(glyph))).toBe(true);
    expect(frame).toContain('54 tools');
  });

  it('draws a settled one flat — no spinner anywhere on it', async () => {
    const frame = await frameFor(EDelegateStatus.completed);
    // The whole point: this is the frame that used to be indistinguishable from the one above.
    expect(SPINNER_FRAMES.some((glyph) => frame.includes(glyph))).toBe(false);
    expect(frame).toContain('54 tools');
  });

  it('marks a failed one in its gutter, where a running one has the spinner', async () => {
    const frame = await frameFor(EDelegateStatus.failed);
    expect(frame).toContain('✗');
    expect(frame).toContain('failed');
  });
});
