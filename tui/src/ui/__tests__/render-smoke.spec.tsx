import { describe, expect, it } from 'bun:test';
import { createCliRenderer } from '@opentui/core';
import { createRoot } from '@opentui/react';
import React from 'react';
import { attachmentExpandKey } from '../../domain/attachments.js';
import {
  openableRoles,
  openThreadTitle,
  startPhaseTitle,
  startablePhases,
} from '../../domain/human-verbs.js';
import { DECLINED_NOTICE } from '../../domain/transition-review.js';
import { EContextSignal } from '../../domain/context-nudge.js';
import { EHarnessVariant, type Message, type ToolResultPayload } from '../../domain/message.js';
import type { TaskView } from '../../domain/tasks.js';
import {
  EAccountStatus,
  EEngine,
  EMessageType,
  EPhaseKind,
  ESessionEndReason,
  ETaskStatus,
} from '../../generated/prisma/enums.js';
import { Breadcrumb } from '../components/breadcrumb.js';
import { Checklist } from '../components/checklist.js';
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
import {
  ProposalFooter,
  reviewRows,
  TransitionConfirm,
} from '../components/transition-confirm.js';
import { VerbMenu } from '../components/verb-menu.js';
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

  // A hand-off with files on it, which is the shape every seam message actually arrives in. Both
  // states mount, because expanding puts a whole file's lines inside a block that is itself a column
  // of `<text>` — and one of those files has a line far wider than the viewport.
  it('renders a hand-off with its attachment chips, collapsed and expanded', async () => {
    const handoff = message({
      type: EMessageType.harness,
      variant: EHarnessVariant.handoff,
      text: 'Slice 2 is done. I rejected a shared cache.',
      attachments: [
        {
          label: 'context/specs/spec.md',
          lines: 3,
          bytes: 5_500,
          body: `the plan\n${'x'.repeat(400)}\nlast line`,
        },
        // A file that was not there: it keeps its chip in red rather than vanishing.
        { label: 'context/specs/gone.md', lines: 0, bytes: 0, body: null },
      ],
    });
    for (const expanded of [new Set<string>(), new Set([attachmentExpandKey(handoff.id)])]) {
      await expect(
        mount(<MessageView message={handoff} expandedTools={expanded} width={100} />),
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
            width={100}
            facts={{
              jobTitle: 'a job',
              repo: 'atlas',
              role: 'charting',
              sessionOrdinal: 1,
              engine: 'claude',
              model: 'opus',
              branch: null,
              siblings: 0,
              closed: false,
            }}
          />
          <HintLine
            hints="? for shortcuts"
            contextPercent={{ percent: 26, signal: EContextSignal.budget }}
            fiveHour={{ utilization: 33, resetsAt: null }}
            sevenDay={null}
            width={100}
          />
          {/* Over budget AND with the canary driving: the one state where the meter changes its
              label rather than only its colour, and the one most likely to break the strip's
              width arithmetic. */}
          <HintLine
            hints="? for shortcuts"
            contextPercent={{ percent: 127, signal: EContextSignal.canary }}
            fiveHour={{ utilization: 33, resetsAt: null }}
            sevenDay={null}
            width={100}
          />
          <SessionSeam ordinal={2} endReason={ESessionEndReason.context_wall} width={72} />
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

  /**
   * The checklist draws a styled `<span>` inside its row's `<text>`, which is the shape that throws
   * at mount if it is ever wrapped in another `<text>`. Every status, a windowed long list, and the
   * empty case that must render nothing at all rather than an empty panel.
   */
  it('renders the checklist in every state it has', async () => {
    const plan: TaskView[] = [
      { ordinal: 1, text: 'wire the composer', status: ETaskStatus.completed },
      { ordinal: 2, text: 'render the checklist', status: ETaskStatus.in_progress },
      { ordinal: 3, text: 'test the exclusion', status: ETaskStatus.pending },
      { ordinal: 4, text: 'a retired task', status: ETaskStatus.deleted },
      { ordinal: 5, text: `a task with a name far wider than any terminal ${'x'.repeat(200)}`, status: ETaskStatus.pending },
    ];
    for (const width of [100, 40]) {
      await expect(mount(<Checklist tasks={plan} width={width} />)).resolves.toBeUndefined();
      await expect(
        mount(<Checklist tasks={plan} width={width} maxRows={2} />),
      ).resolves.toBeUndefined();
      await expect(mount(<Checklist tasks={[]} width={width} />)).resolves.toBeUndefined();
    }
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

  /**
   * The human's two creation menus, drawn from the real tables rather than from a literal — a phase
   * whose `next` is empty is the case the menu exists for, and a menu with more entries than rows is
   * what makes `OverlayList` window rather than grow the footer.
   */
  it('renders the start-a-phase and open-a-thread menus', async () => {
    const phases = startablePhases(EPhaseKind.ci);
    const roles = openableRoles(EPhaseKind.planning);
    await expect(
      mount(
        <>
          <VerbMenu
            title={startPhaseTitle(EPhaseKind.ci)}
            items={phases.map((choice) => ({
              id: choice.kind,
              label: choice.label,
              ...(choice.suggested ? { hint: 'proposed from here' } : {}),
            }))}
            selected={phases.length - 1}
            caption="↑↓ select · ⏎ start · esc cancel"
            error="no job job-1"
          />
          <VerbMenu
            title={openThreadTitle(EPhaseKind.planning)}
            items={roles.map((choice) => ({ id: choice.role, label: choice.label }))}
            selected={0}
            caption="↑↓ select · ⏎ open · esc cancel"
          />
          {/* A phase that hosted no roles would forbid human threads by construction. None does. */}
          <VerbMenu title="open a thread" items={[]} selected={0} caption="esc cancel" />
          <ConfirmBar
            question="close the ship pr thread?"
            detail="recorded as abandoned · nothing else is open in this phase"
            confirmLabel="close"
          />
        </>,
      ),
    ).resolves.toBeUndefined();
  });

  /**
   * The confirm overlay, in both of its shapes and at a width that cannot hold its content.
   *
   * It is the densest thing in the footer: markdown inside a box inside a scrollbox, with a file
   * body that has a line far wider than the terminal. Every one of those is a chance at the nested
   * `<text>` crash, and the wide line is the case the wide-content rules exist for.
   */
  it.each([100, 40])('renders the transition confirm at %i columns', async (width) => {
    const view = {
      route: 'planning → build',
      reason: 'The plan is written. **Three slices**, two of them already scaffolded.',
      handoff: '## What is done\n\nthe schema\n\n## What is next\n\nthe overlay',
      files: ['context/specs/plan.md', 'context/specs/gone.md'],
    };
    const parts = [
      {
        label: 'context/specs/plan.md',
        lines: 3,
        bytes: 5_500,
        body: `# The plan\n\n- slice one\n${'x'.repeat(400)}`,
      },
      // Tidied away between the proposal and the keypress: the chip stays, in red.
      { label: 'context/specs/gone.md', lines: 0, bytes: 0, body: null },
    ];
    for (const expanded of [false, true]) {
      await expect(
        mount(
          <TransitionConfirm
            view={view}
            parts={parts}
            expanded={expanded}
            width={width}
            maxRows={reviewRows(30)}
            error="this proposal was already confirmed"
          />,
        ),
      ).resolves.toBeUndefined();
    }

    // And the footer that decides which of its three states is up — including the two the overlay
    // itself never draws: the line that brings back a deferred proposal, and the one after `n`.
    const controls = {
      view,
      parts,
      open: false,
      waiting: true,
      expanded: false,
      busy: false,
      error: null,
      notice: DECLINED_NOTICE,
    };
    for (const open of [false, true]) {
      await expect(
        mount(
          <ProposalFooter
            proposal={{ ...controls, open, waiting: !open }}
            width={width}
            height={30}
          />,
        ),
      ).resolves.toBeUndefined();
    }
  });
});
