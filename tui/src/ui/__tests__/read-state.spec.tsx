import type { ScrollBoxRenderable } from '@opentui/core';
import { testRender } from '@opentui/react/test-utils';
import { describe, expect, it } from 'bun:test';
import React from 'react';
import type { ConversationState } from '../../app/conversation.store.js';
import type { Message } from '../../domain/message.js';
import type { TranscriptItem } from '../../domain/seam.js';
import { EMessageType } from '../../generated/prisma/enums.js';
import { JumpToBottom, NewDivider, UNSEEN_ANCHOR_ID } from '../components/new-divider.js';
import { Transcript } from '../components/transcript.js';
import { TRANSCRIPT_INSET } from '../theme.js';

/**
 * The landing mechanic, mounted for real.
 *
 * `scrollChildIntoView` takes a renderable id, which means the `id` prop has to survive React's
 * reconciler and reach the box — nothing in the type system says it does, and the whole "open a
 * thread on the oldest thing you have not seen" behaviour hangs off it. Only a real renderer knows.
 */

const WIDTH = 60;
const HEIGHT = 20;
const COUNT = 40;
const ANCHOR_INDEX = 10;

function message(index: number): Message {
  return {
    id: `m-${index}`,
    payload: { type: EMessageType.assistant, text: `message number ${index}` },
  } as unknown as Message;
}

const MESSAGES: Message[] = Array.from({ length: COUNT }, (_, index) => message(index));
const ITEMS: TranscriptItem[] = MESSAGES.map((m) => ({ kind: 'message', message: m }));

const STATE: ConversationState = {
  messages: MESSAGES,
  tail: null,
  runningTool: null,
  running: false,
  startedAt: null,
  outputTokens: 0,
  lastTurn: null,
  interrupting: false,
  queued: [],
  contextReading: null,
  fiveHour: null,
  sevenDay: null,
  notices: [],
  delegates: [],
  holding: false,
  noAccount: null,
  closed: false,
};

async function mount(args: {
  anchorMessageId: string | null;
  showDivider: boolean;
  /** Mounted the way the page mounts it: absolutely, inside the box the transcript fills. */
  jump?: boolean;
}) {
  let scroller: ScrollBoxRenderable | null = null;
  const setup = await testRender(
    <box flexDirection="column" width={WIDTH} height={HEIGHT}>
      <Transcript
        items={ITEMS}
        itemKeys={MESSAGES.map((m) => m.id)}
        state={STATE}
        toolResults={new Map()}
        expandedTools={new Set()}
        onToggleTool={() => undefined}
        inFlight={new Set()}
        now={0}
        frame="⠋"
        cwd="/tmp"
        width={WIDTH}
        scroller={{
          get current() {
            return scroller;
          },
          set current(value: ScrollBoxRenderable | null) {
            scroller = value;
          },
        }}
        anchorMessageId={args.anchorMessageId}
        showDivider={args.showDivider}
      />
      {args.jump ? <JumpToBottom width={WIDTH} onJump={() => undefined} /> : null}
    </box>,
    { width: WIDTH, height: HEIGHT },
  );
  await setup.flush();
  return { setup, scroller: () => scroller as ScrollBoxRenderable | null };
}

describe('the unseen anchor', () => {
  it('is findable by id, so the transcript can be told to land on it', async () => {
    const { setup, scroller } = await mount({
      anchorMessageId: `m-${ANCHOR_INDEX}`,
      showDivider: true,
    });
    try {
      expect(scroller()?.content.findDescendantById(UNSEEN_ANCHOR_ID)).toBeDefined();
    } finally {
      setup.renderer.destroy?.();
    }
  });

  it('scrolls away from the bottom when the transcript lands on it', async () => {
    const { setup, scroller } = await mount({
      anchorMessageId: `m-${ANCHOR_INDEX}`,
      showDivider: true,
    });
    try {
      const box = scroller();
      // Sticky-scroll starts at the end; landing has to move off it or the divider is above you.
      const bottom = box?.scrollTop ?? 0;
      expect(bottom).toBeGreaterThan(0);

      box?.scrollChildIntoView(UNSEEN_ANCHOR_ID);
      await setup.flush();

      expect(box?.scrollTop ?? 0).toBeLessThan(bottom);
    } finally {
      setup.renderer.destroy?.();
    }
  });

  it('draws the rule above the message it marks', async () => {
    const { setup, scroller } = await mount({
      anchorMessageId: `m-${ANCHOR_INDEX}`,
      showDivider: true,
    });
    try {
      // The rule is thirty messages up: it only exists on screen once the landing has happened,
      // which is exactly the sequence the page runs.
      scroller()?.scrollChildIntoView(UNSEEN_ANCHOR_ID);
      await setup.flush();
      const lines = setup.captureCharFrame().split('\n');
      const rule = lines.findIndex((line) => line.includes(' new '));
      const marked = lines.findIndex((line) => line.includes(`message number ${ANCHOR_INDEX}`));

      expect(rule).toBeGreaterThanOrEqual(0);
      expect(rule).toBeLessThan(marked);
    } finally {
      setup.renderer.destroy?.();
    }
  });

  it('draws no rule when everything is new — a rule at the top separates nothing', async () => {
    const { setup } = await mount({ anchorMessageId: 'm-0', showDivider: false });
    try {
      expect(setup.captureCharFrame()).not.toContain(' new ');
    } finally {
      setup.renderer.destroy?.();
    }
  });
});

describe('the read-state chrome mounts', () => {
  it('renders the rule', async () => {
    const setup = await testRender(
      <box flexDirection="column" width={WIDTH} height={HEIGHT}>
        <NewDivider width={WIDTH} />
      </box>,
      { width: WIDTH, height: HEIGHT },
    );
    try {
      await setup.flush();
      expect(setup.captureCharFrame()).toContain('new');
    } finally {
      setup.renderer.destroy?.();
    }
  });
});

describe('the way back down', () => {
  it('floats at the bottom of the transcript, centred, taking none of its rows', async () => {
    const plain = await mount({ anchorMessageId: null, showDivider: false });
    const rowsWithout = plain.setup.captureCharFrame().split('\n').length;
    plain.setup.renderer.destroy?.();

    const { setup } = await mount({
      anchorMessageId: null,
      showDivider: false,
      jump: true,
    });
    try {
      const lines = setup.captureCharFrame().split('\n');
      // Same number of rows either way: an overlay costs the transcript nothing.
      expect(lines.length).toBe(rowsWithout);

      // ONE row, and it is the last row of the region: the pill sits AT the end of the scroll — the
      // thing it takes you to — rather than a panel away from it, and it blanks a single line of
      // transcript to do so.
      const row = lines.findIndex((line) => line.includes('jump to bottom'));
      expect(row).toBe(HEIGHT - 1);

      // Centred over the column the transcript actually draws in — which is the terminal less the
      // scrollbar and its padding, so the two gaps are equal against `WIDTH - TRANSCRIPT_INSET`,
      // not against `WIDTH`. Off by at most one, since an odd remainder cannot be split evenly.
      const line = lines[row] ?? '';
      const left = line.indexOf('⌄');
      const right = line.lastIndexOf('b');
      expect(left).toBeGreaterThan(0);
      expect(Math.abs(left - 1 - (WIDTH - 1 - TRANSCRIPT_INSET - (right + 1)))).toBeLessThanOrEqual(
        1,
      );
    } finally {
      setup.renderer.destroy?.();
    }
  });
});
