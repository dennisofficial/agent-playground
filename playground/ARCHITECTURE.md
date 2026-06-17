# Atlas Harness Architecture

This document describes the current backend harness architecture after the Atlas migration. The
older playground design was useful as a prototype, but the production shape is now a single
orchestrated NestJS backend rather than one process per employee.

## Runtime Shape

- **Single backend process.** The harness runs inside one NestJS process. There is one conductor and
  one set of durable stores for a workspace.
- **`HarnessModule` is the composition root.** It imports the harness domains, registers employee
  and tool providers, and wires optional surfaces such as Slack or the TUI.
- **`ConductorService` owns the central event loop.** Surfaces normalize inbound messages into
  conductor events. The conductor gates the event, builds the target employee graph, runs the turn,
  writes channel state, and publishes status events.
- **Atlas is the sole orchestrator and team lead.** Atlas owns the team board, plan review,
  proposal flow, standup gate, and PR acceptance bookkeeping.
- **Specialists run as pipeline-stage sessions.** Alex, Riley, Maya, James, Nora, and other
  specialists do not orchestrate the team. Their work happens in board-linked planning or execution
  sessions that report back to Atlas through the harness.
- **Slack and TUI are surfaces.** They bind the `CHAT_SURFACE` port and feed the same conductor.
  Slack adds approval cards, snippets, and interactivity; the TUI is a local presentation surface.

## Main Flow

1. A surface sends an inbound event to `ConductorService`.
2. The conductor selects the addressed employee and runs a LangGraph turn with that employee's
   persona, tools, memory, and surface context.
3. Atlas uses board tools to create, assign, review, propose, and close work.
4. Specialists open background sessions for planning and execution. Submitted plans attach to board
   tickets for Atlas's review.
5. Approved work executes in git worktrees. The review pipeline opens draft PRs, runs self-review,
   and hands the final ready-for-review decision back to the owner.
6. Dennis reviews the proposal or PR through Slack, GitHub, or the active surface. Atlas records the
   accepted outcome on the board.

## Important Boundaries

- The team board is durable state in `BoardStore`; it is not a playground-only command surface.
- Employee allowlists are class references registered through Nest discovery, not per-process tool
  registries.
- Worktrees are per project and converge shared features through `shared/<slug>` integration
  branches.
- The approval pipeline is explicit: owner submits plan, Atlas approves/proposes, Dennis approves,
  standup closes, execution starts.
- Surfaces should remain adapters. Business rules belong in harness services and tools, not Slack
  or TUI presentation code.
