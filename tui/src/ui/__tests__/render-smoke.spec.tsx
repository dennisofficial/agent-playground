import { describe, expect, it } from 'bun:test';
import { createCliRenderer } from '@opentui/core';
import { createRoot } from '@opentui/react';
import React from 'react';
import { EHarnessVariant, type Message, type ToolResultPayload } from '../../domain/message.js';
import { EAccountStatus, EEngine, EMessageType } from '../../generated/prisma/enums.js';
import { Breadcrumb } from '../components/breadcrumb.js';
import { Composer } from '../components/composer.js';
import { ConfirmBar } from '../components/confirm-bar.js';
import { HintLine } from '../components/hint-line.js';
import { PageHeader } from '../components/page-header.js';
import { MessageView } from '../components/message-view.js';
import { OverlayList } from '../components/overlay-list.js';
import { SessionSeam, SwapNotice } from '../components/blocks/error-block.js';
import { JumpToBottom, NewDivider } from '../components/new-divider.js';
import { ToolRunningLine } from '../components/blocks/tool-block.js';
import { WorkingLine } from '../components/working-line.js';
import { AccountGroup, accountsLayout } from '../components/account-list.js';
import { NewJobPage } from '../pages/new-job.js';
import type { AccountRow } from '../../app/accounts.service.js';

/**
 * Every conversation-page component, mounted for real.
 *
 * OpenTUI's `<text>` accepts strings, text nodes and styled text — NOT nested `<text>` elements.
 * A component that returns `<text>` and is rendered inside another `<text>` therefore throws at
 * mount, and nothing in the type system catches it: the nesting only exists once the component has
 * been expanded. That shipped twice during the migration, both times found by a user opening a
 * page. Mounting each component here turns that into a test failure instead.
 */

function message(payload: Message['payload']): Message {
  return { id: `m-${payload.type}`, payload } as unknown as Message;
}

const MESSAGES: Message[] = [
  message({ type: EMessageType.user, text: 'a question\nwith two lines' }),
  message({ type: EMessageType.assistant, text: 'an answer with `code` and **bold**' }),
  // Markdown that exercises the whole pipeline: prose either side of a labelled fence, which is
  // segmented out and routed to the Tree-sitter renderer rather than rendered as prose.
  message({
    type: EMessageType.assistant,
    text: [
      '## A heading',
      '',
      'Some prose with **bold**, `inline code` and a [link](https://example.com).',
      '',
      '- one',
      '- two',
      '',
      '```ts',
      'const x: number = 1;',
      '// a comment',
      'function hello() { return x; }',
      '```',
      '',
      'Trailing prose after the fence.',
    ].join('\n'),
  }),
  // A fence wider than any sane viewport: proves the block reports overflow rather than wrapping.
  message({
    type: EMessageType.assistant,
    text: ['```ts', `const wide = ${'\'x\''.repeat(60)};`, '```'].join('\n'),
  }),
  // An unlabelled fence falls through to the plain renderer.
  message({ type: EMessageType.assistant, text: '```\nno language here\n```' }),
  message({ type: EMessageType.thinking, text: 'thinking out loud' }),
  message({ type: EMessageType.tool_call, toolUseId: 't1', name: 'Read', target: 'a/b.ts', input: {} }),
  message({
    type: EMessageType.tool_result,
    toolUseId: 't1',
    ok: true,
    summary: 'Read 12 lines',
    detail: ['one', 'two'],
  }),
  message({ type: EMessageType.error, title: 'API Error: 529', detail: 'Retrying 2/5', retryable: true }),
  // Every harness variant, because the block switches on it — and a multi-line one, which is the
  // shape a hand-off actually arrives in.
  ...Object.values(EHarnessVariant).map((variant) =>
    message({ type: EMessageType.harness, variant, text: `injected as ${variant}\nsecond line` }),
  ),
];

function account(fields: Partial<AccountRow>): AccountRow {
  return {
    id: `a-${fields.label ?? 'x'}`,
    label: 'someone@example.com',
    engine: EEngine.claude,
    status: EAccountStatus.active,
    subscriptionType: 'max20',
    isActive: false,
    fiveHourUtil: null,
    fiveHourResetsAt: null,
    sevenDayUtil: null,
    sevenDayResetsAt: null,
    ...fields,
  } as unknown as AccountRow;
}

const ACCOUNTS: AccountRow[] = [
  // Measured, unknown, spent-with-a-clock, and a label past the column width.
  account({ label: 'measured', isActive: true, fiveHourUtil: 34, sevenDayUtil: 61 }),
  account({ label: 'unmeasured' }),
  account({
    label: 'spent',
    fiveHourUtil: 100,
    fiveHourResetsAt: new Date('2026-08-02T12:00:00Z'),
    sevenDayUtil: 88,
    status: EAccountStatus.limited,
  }),
  account({ label: 'a-very-long-address@some-long-domain.example.com', fiveHourUtil: 4 }),
];

async function mount(node: React.ReactNode): Promise<void> {
  const renderer = await createCliRenderer({ width: 100, height: 30, useMouse: false });
  try {
    createRoot(renderer).render(<>{node}</>);
    // A frame has to actually be built; mounting alone does not append children.
    await new Promise((resolve) => setTimeout(resolve, 30));
  } finally {
    renderer.destroy?.();
  }
}

describe('conversation page components mount', () => {
  it('renders every message type', async () => {
    for (const m of MESSAGES) {
      await expect(mount(<MessageView message={m} />)).resolves.toBeUndefined();
    }
  });

  // The diff draws columns inside a `<text>`, which is exactly the shape that throws at mount if a
  // component underneath it returns `<text>` of its own. Collapsed and expanded are separate paths.
  it('renders an edit with its diff, folded and open', async () => {
    const call = message({
      type: EMessageType.tool_call,
      toolUseId: 't9',
      name: 'Edit',
      target: 'src/a.ts',
      input: {},
    });
    const results = new Map([
      [
        't9',
        {
          type: EMessageType.tool_result,
          toolUseId: 't9',
          ok: true,
          summary: 'Updated with 2 additions and 1 removal',
          detail: ['The file has been updated.'],
          diff: [
            { oldStart: 47, newStart: 47, lines: [' }', '-  return old;', '+  return next;'] },
            // A second hunk, a line longer than the viewport, and a wide line number — the three
            // things that decide the gutter, the gap row and the clip.
            { oldStart: 900, newStart: 901, lines: [`+${'x'.repeat(200)}`] },
          ],
        } as ToolResultPayload,
      ],
    ]);
    for (const expanded of [new Set<string>(), new Set(['t9'])]) {
      await expect(
        mount(
          <MessageView message={call} toolResults={results} expandedTools={expanded} width={100} />,
        ),
      ).resolves.toBeUndefined();
    }
  });

  it('renders the composer, empty and with a draft', async () => {
    await expect(mount(<Composer value="" width={80} />)).resolves.toBeUndefined();
    await expect(mount(<Composer value={'a draft\nof two lines'} width={80} />)).resolves.toBeUndefined();
  });

  it('renders the chrome', async () => {
    await expect(
      mount(
        <>
          <Breadcrumb
            project="atlas"
            job="a job"
            role="intake"
            sessionOrdinal={1}
            engine="claude"
            model="opus"
            width={100}
          />
          <HintLine
            hints="? for shortcuts"
            contextPercent={26}
            fiveHour={{ utilization: 33, resetsAt: null }}
            sevenDay={null}
            width={100}
          />
          <SessionSeam ordinal={2} width={72} />
          <NewDivider width={72} />
          <JumpToBottom onJump={() => undefined} />
          <SwapNotice text="swapped account" />
          <ToolRunningLine frame="⠋" elapsed="3s" lines={['reading']} />
          <WorkingLine
            running
            elapsedMs={3000}
            frame="⠋"
            outputTokens={12}
            queued={[]}
            interrupting={false}
          />
          <WorkingLine
            running={false}
            elapsedMs={125_000}
            frame="⠋"
            outputTokens={45_000}
            queued={[]}
            interrupting={false}
          />
          <OverlayList items={[{ id: '/help', label: '/help', hint: 'shortcuts' }]} selected={0} />
        </>,
      ),
    ).resolves.toBeUndefined();
  });

  // Every usage state an account row can be in, because each one takes a different branch through
  // `meterSpans` — and it was the meters, returned as a `<text>` inside the row's `<text>`, that
  // took the accounts page down. Each width picks a different row form, including the wrapped one,
  // which is a second `<text>` inside a `<box>` and so a second chance at the same mistake.
  it.each([200, 100, 70, 50, 30])('renders account rows at %i columns', async (width) => {
    await expect(
      mount(
        <AccountGroup
          label="claude"
          accounts={ACCOUNTS}
          rows={ACCOUNTS}
          selected={0}
          layout={accountsLayout(width, ACCOUNTS)}
        />,
      ),
    ).resolves.toBeUndefined();
  });

  // A whole page rather than a block, but the mount rule is the same one: a `<text>` inside a
  // `<text>` only exists once the tree is expanded, and this page draws a composer inside a screen.
  it('renders the pending-job page', async () => {
    await expect(
      mount(
        <NewJobPage
          projectName="atlas"
          onSubmit={async () => undefined}
          onCancel={() => undefined}
        />,
      ),
    ).resolves.toBeUndefined();
  });

  it('renders the shared page chrome', async () => {
    await expect(
      mount(
        <>
          <PageHeader trail={['atlas']} />
          <PageHeader trail={['atlas', 'a project']} right="3/12" canBack />
          <ConfirmBar question="delete “a job”?" detail="24 messages go with it" />
        </>,
      ),
    ).resolves.toBeUndefined();
  });
});
