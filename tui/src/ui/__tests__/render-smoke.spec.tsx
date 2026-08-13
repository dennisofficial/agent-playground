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
import {
  EDelegateStatus,
  EHarnessVariant,
  type Message,
  type ToolResultPayload,
} from '../../domain/message.js';
import type { Delegates } from '../../domain/delegates.js';
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
import { BackgroundAgents } from '../components/background-agents.js';
import { JumpToBottom, NewDivider } from '../components/new-divider.js';
import { highlightRows } from '../markdown/highlight-rows.js';
import { ToolGroupBlock } from '../components/blocks/tool-group-block.js';
import { ThinkingBlock } from '../components/blocks/thinking-block.js';
import { EHit, hitKey, type GroupMember, type ToolGroup } from '../../domain/tool-group.js';
import { presentTool } from '../../domain/tool-view.js';
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

/**
 * Two delegates in the states that draw the most: one background agent still working with a gist to
 * quote, and one settled — the row that has to STOP saying present-tense things about itself.
 */
const DELEGATE_NOW = 1_000_000;
const DELEGATES: Delegates = [
  {
    taskId: 'task-1',
    toolUseId: 'toolu_parent',
    agentType: 'Explore',
    taskType: 'local_agent',
    description: 'Find transcript markdown rendering',
    background: true,
    status: EDelegateStatus.running,
    toolUses: 14,
    lastTool: 'Grep',
    progress: 'Analyzing the markdown layer',
    startedAt: DELEGATE_NOW - 134_000,
    contextTokens: 11_511,
    contextLimit: 200_000,
  },
  {
    taskId: 'task-2',
    toolUseId: 'toolu_other',
    taskType: 'local_bash',
    description: 'pnpm test',
    background: true,
    status: EDelegateStatus.running,
    toolUses: 0,
    startedAt: DELEGATE_NOW - 41_000,
  },
];

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
  const root = createRoot(renderer);
  try {
    root.render(<>{node}</>);
    // A frame has to actually be built; mounting alone does not append children.
    await new Promise((resolve) => setTimeout(resolve, 30));
  } finally {
    // Unmount BEFORE destroying the renderer, so effects get their cleanup. Destroying alone left
    // the tree mounted: anything holding a timer — the working line's shimmer clock — kept ticking
    // into a dead renderer for the rest of the suite, one orphaned interval per mount.
    root.unmount();
    renderer.destroy?.();
  }
}

/**
 * Highlight the content this file is about to mount, BEFORE mounting it.
 *
 * `renderer.destroy()` tears down the process-wide Tree-sitter client, and `useHighlightedRows` starts
 * its pass in an effect. Mount-then-destroy therefore kills a pass mid-flight, and every LATER spec
 * file that highlights then fails with `TreeSitter client destroyed` — which is how three unrelated
 * specs broke while each still passed on its own.
 *
 * Warming the cache first makes the mount synchronous: `useHighlightedRows` resolves a cache hit in
 * its initial state rather than through an effect, so there is no pass left to interrupt. Deterministic,
 * where a longer settle would only have made the race rarer.
 */
async function warm(lines: readonly string[], filetype: string): Promise<void> {
  await highlightRows({ lines, filetype });
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

  // The Agent block with a live delegate under it — the block whose whole job is to say what a
  // delegate is doing WITHOUT quoting a word of it. Running and settled, because the second state
  // drops the gist and takes the outcome in the same slot.
  it('renders an Agent call with its delegate, running and settled', async () => {
    const call = message({
      type: EMessageType.tool_call,
      toolUseId: 'toolu_parent',
      name: 'Agent',
      input: { description: 'Find transcript rendering', subagent_type: 'Explore' },
    });
    const settled: Delegates = [
      {
        ...(DELEGATES[0] as Delegates[number]),
        status: EDelegateStatus.completed,
        endedAt: DELEGATE_NOW,
      },
    ];
    for (const delegates of [DELEGATES, settled]) {
      await expect(
        mount(
          <MessageView
            message={call}
            delegates={delegates}
            now={DELEGATE_NOW}
            width={100}
          />,
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
            contextReading={{ tokens: 52_000, percent: 26, band: 'normal', signal: EContextSignal.budget }}
            fiveHour={{ utilization: 33, resetsAt: null }}
            sevenDay={null}
            width={100}
          />
          {/* Nearly full AND with the canary driving: the one state where the meter changes its
              label rather than only its colour, and the one most likely to break the strip's
              width arithmetic. */}
          <HintLine
            hints="? for shortcuts"
            contextReading={{ tokens: 194_000, percent: 97, band: 'red', signal: EContextSignal.canary }}
            fiveHour={{ utilization: 33, resetsAt: null }}
            sevenDay={null}
            width={100}
          />
          <SessionSeam ordinal={2} endReason={ESessionEndReason.context_wall} width={72} />
          <NewDivider width={72} />
          <JumpToBottom width={72} onJump={() => undefined} />
          <SwapNotice text="swapped account" />
          <BackgroundAgents delegates={DELEGATES} width={100} now={DELEGATE_NOW} />
          <WorkingLine
            running
            elapsedMs={3000}
            frame="⠋"
            outputTokens={12}
            queued={[]}
            interrupting={false}
          />
          {/* Held: the model has stopped, the session has not. A third state with its own words. */}
          <WorkingLine
            running
            holding
            elapsedMs={134_000}
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

/**
 * A tool group, in every state it has.
 *
 * The group is the densest thing in the transcript: three `<span>` columns inside a row's `<text>`,
 * an opened body that puts syntax-highlighted chunks inside another `<text>`, and mouse handlers on
 * both. Each of those is a chance at the nested-`<text>` crash, which only exists once the tree is
 * expanded and which the type system cannot see.
 */
function member(args: {
  id: string;
  name: string;
  input: unknown;
  ok?: boolean;
  detail?: string[];
}): GroupMember {
  const result =
    args.detail === undefined && args.ok === undefined
      ? undefined
      : ({
          type: EMessageType.tool_result,
          toolUseId: args.id,
          ok: args.ok ?? true,
          summary: args.ok === false ? 'File does not exist. Note: your cwd is /repo.' : 'done',
          detail: args.detail ?? [],
        } as ToolResultPayload);
  const payload = {
    type: EMessageType.tool_call,
    toolUseId: args.id,
    name: args.name,
    input: args.input,
  } as Message['payload'] & { type: typeof EMessageType.tool_call };
  return {
    payload,
    ...(result ? { result } : {}),
    view: presentTool({ name: args.name, input: args.input, cwd: '/repo', ...(result ? { result } : {}) }),
  };
}

const MIXED: GroupMember[] = [
  member({ id: 'g1', name: 'Read', input: { file_path: '/repo/src/domain/tool-view.ts' }, detail: ['a', 'b'] }),
  // A failed read: its error lives only in `summary`, and the opened body is the only place it shows.
  member({ id: 'g2', name: 'Read', input: { file_path: '/repo/gone.ts' }, ok: false }),
  // A multi-line command with a description — the header shows the words, the body shows the command,
  // highlighted as bash.
  member({
    id: 'g3',
    name: 'Bash',
    input: {
      command: "f=$(ls -S ~/.atlas/*/raw.jsonl | head -1)\npython3 -c 'import json, sys\nprint(json.load(sys.stdin))'",
      description: 'Inspect result frames in the largest raw tape',
    },
    detail: ['line one', `wide ${'x'.repeat(400)}`],
  }),
  member({ id: 'g4', name: 'Grep', input: { pattern: 'input_ack|state\\.live' }, detail: ['1', '2', '3'] }),
  member({ id: 'g5', name: 'Read', input: { file_path: '/repo/src/app/turn-runner.service.ts' }, detail: ['x'] }),
  member({ id: 'g6', name: 'Read', input: { file_path: '/repo/src/app/turn-lanes.ts' }, detail: ['x'] }),
  // Past `GROUP_ROWS`, so the elision marker draws.
  member({ id: 'g7', name: 'Read', input: { file_path: '/repo/src/app/turn-events.ts' }, detail: ['x'] }),
  // In flight: no result at all.
  member({ id: 'g8', name: 'Read', input: { file_path: '/repo/src/app/turn-args.ts' } }),
];

function toolGroup(members: GroupMember[]): ToolGroup {
  return {
    kind: 'tool_group',
    id: members[0]?.payload.toolUseId ?? 'g1',
    messageIds: members.map((m) => m.payload.toolUseId),
    members,
  };
}

describe('tool group', () => {
  it.each([120, 80, 40])('renders collapsed, open and streaming at %i columns', async (width) => {
    const group = toolGroup(MIXED);
    // Every body this test opens, pre-highlighted — see `warm`.
    for (const member of MIXED) {
      if (member.view.command.length > 0) await warm(member.view.command, 'bash');
      if (member.result) await warm(member.result.detail.slice(0, 6), 'typescript');
    }
    const states: ReadonlySet<string>[] = [
      new Set(),
      // Open: every row draws.
      new Set([hitKey(EHit.group, group.id)]),
      // One row open — including the FAILED one, whose body is its error, and the bash one, whose
      // body is a highlighted multi-line command with a line far wider than the terminal.
      new Set([hitKey(EHit.call, 'g2')]),
      new Set([hitKey(EHit.call, 'g3')]),
      // Group open AND a row open inside it, which is a body nested two levels down.
      new Set([hitKey(EHit.group, group.id), hitKey(EHit.call, 'g3')]),
      // A row open AND all of its output shown — the third level, and the case where a wrapped,
      // syntax-highlighted command sits above hundreds of plain lines.
      new Set([hitKey(EHit.call, 'g3'), hitKey(EHit.output, 'g3')]),
    ];
    for (const expanded of states) {
      for (const running of [new Set<string>(), new Set(['g8'])]) {
        await expect(
          mount(
            <ToolGroupBlock
              group={group}
              width={width}
              running={running}
              expanded={expanded}
              onToggle={() => undefined}
              frame="⠋"
              elapsed="4s"
            />,
          ),
        ).resolves.toBeUndefined();
      }
    }
  });

  // A group of one tool has no verb column; a group that spans tools does. Different span counts per
  // row, which is the shape that breaks if a column is assembled wrong.
  it('renders a single-tool group, which draws no verb column', async () => {
    const group = toolGroup(MIXED.filter((m) => m.payload.name === 'Read'));
    await expect(
      mount(
        <ToolGroupBlock
          group={group}
          width={100}
          expanded={new Set([hitKey(EHit.group, group.id)])}
          onToggle={() => undefined}
        />,
      ),
    ).resolves.toBeUndefined();
  });
});

describe('thinking', () => {
  it('renders collapsed, expanded and streaming', async () => {
    const text = ['A first paragraph that runs on for a while and has to wrap somewhere sensible.', '', `wide ${'y'.repeat(300)}`].join('\n');
    for (const props of [
      { text },
      { text, expanded: true },
      { text, streaming: true },
      // Long enough to trip the live tail's `… +N lines above` head-cut.
      { text: Array.from({ length: 40 }, (_, i) => `reasoning line ${i}`).join('\n'), streaming: true },
      { text, expanded: true, onToggle: () => undefined },
    ]) {
      await expect(mount(<ThinkingBlock {...props} width={100} />)).resolves.toBeUndefined();
    }
  });
});
