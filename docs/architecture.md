# Atlas architecture

Authoritative. Where the code disagrees about *mechanism*, the code wins; where it disagrees about
*intent*, change the code. Every load-bearing claim here was established by a spike, not by argument
— evidence in `docs/research/`, seams in `docs/core-contract.md`.

## What Atlas is

A coding-agent harness in the shape of Claude Code. The agentic loop is ours: we make raw model calls
and own every decision the loop makes — what context the model sees, which tools may run, when a
human is asked, what happens on rewind. Because the calls are raw, Atlas is model-agnostic by
construction; Claude and Codex subscription credentials are one provider implementation, not a
foundation.

## The two rules

**1. The model never sees stored state. It sees a projection built fresh for every step.**

```
EventLog (append-only, canonical) → assemble(rules) → annotate → Assembled → one model step
```

There is no accumulating `messages[]` anywhere. Thinking-block tailing, context injection, image
downgrading, compaction, redaction, token budgeting, rewind, fork, and steering are all the same
mechanism: a rule over the log.

**2. One record.**

If a checkpoint and the log are two records of the same run, keeping them from drifting on rewind is
permanent work. This is the whole reason no graph framework is used. LangGraph's checkpointer and
Mastra's `agentic-loop` snapshot are each a second, un-forkable record of loop position — and the
event log already provides durable resume, so it would be bought twice.

## The loop

```ts
async function runTurn({ threadId, signal }: { threadId: string; signal: AbortSignal }) {
  let modelSteps = 0
  let settleAttempted: string | undefined

  await log.append({ threadId, drafts: await hooks.beforeTurn({ threadId }) })

  for (;;) {
    const events = await log.read({ threadId })

    const waiting = outstandingApproval(events)
    if (waiting) return { status: Paused, callId: waiting }

    const pending = pendingCalls(events)[0]
    if (pending) {
      if (pending.callId === settleAttempted) return { status: Failed, message: stalled(pending) }

      settleAttempted = pending.callId
      const settled = await settlePending({ threadId, signal })
      if (settled.paused) return settled.paused
      continue
    }

    const waiting = await drainPending()
    if (waiting.length > 0) await log.append({ threadId, drafts: waiting })

    const { assembled: projected, trace } = assemble({ events, rules, annotators, ctx })
    const assembled = await hooks.beforeStep({ assembled: projected, trace })

    const faults = exchangeFaults(assembled)
    if (faults.length > 0) return { status: Failed, message: report(faults) }

    modelSteps += 1
    settleAttempted = undefined
    const { parts, toolCalls } = await modelStep({ assembled, tools, signal })

    if (parts.length > 0) await log.append({ threadId, drafts: [{ type: 'assistant-said', parts }] })
    for (const [ordinal, call] of toolCalls.entries()) {
      await log.append({ threadId, drafts: [{ type: 'tool-called', ordinal, ...call }] })
    }
    if (toolCalls.length > 0) continue
    if (arrivedUnseen() || (await drainPending()).length > 0) continue

    await log.append({ threadId, drafts: await hooks.afterTurn({ threadId }) })
    return { status: Completed }
  }
}

const resume = runTurn
```

**A turn never returns `Completed` with an unanswered message behind it.** There are three edges back
to the read, not one: a settlement finished, the step emitted tool calls, and — before the hooks that
close the turn — something the model has not seen arrived while the last step was running. A message
the developer typed mid-turn is pulled from the composer's queue at the boundary *before* assembling,
never appended when it was typed: a message not yet consumed is a draft the developer may still edit
or take back, and an append-only log cannot represent that. Draining at the boundary also puts the
message after the assistant turn it followed, which is what keeps the prompt from ending on the
assistant. `AfterTurn` runs once, at the end, on the far side of that check — hooks that append
turn-taking drafts would otherwise restart the loop they were called to close.

**`BeforeTurn` runs once, before the loop, and is not gated the way `AfterTurn` is.** It exists to put
context in the prompt the turn opens with, so anything running after the first `assemble` is too late,
and the hazard that pushed `AfterTurn` behind the awaits-a-reply check does not exist at the start of a
turn. A turn that reads the log and returns `Idle` has therefore already fired its `BeforeTurn`; that
costs nothing for the intended use, because a hook's `additionalContext` becomes a `context-loaded`
draft the log dedupes on content.

**A turn has no step ceiling.** A coding agent works for as long as the work takes, and every bound
Atlas tried — a model-step budget, an iteration backstop — ended turns that were making progress,
handing the developer a resume button for a loop that should never have stopped. Supervision is the
real bound: the developer watches the turn and interrupts it, which the abort signal already carries.
What replaces the backstop is narrower and answers a different question. A `dispatch` that returns
without settling the call it was handed makes no progress at all, and an unbounded loop would spin on
it forever, so the loop remembers which call it last tried to settle and fails naming that call when
the same one comes back around. That is a stuck detector, not a budget: it cannot fire on a turn that
is still working. `modelSteps` survives only as the index handed to rules as `ctx.step`, counting
model calls rather than loop iterations because `nudge.lifetimeSteps` is specified in model steps.

**`settlePending` is built by the loop, not injected into it.** `TurnDeps` takes `dispatch`; the loop
constructs `settlePending` from `dispatch` and the log it already holds. Injecting a pre-built
`settlePending` meant it closed over a *different* log than the loop wrote through — two logs writing
one thread in a single turn, which the delta-publishing wrapper makes reachable. Absent `dispatch`,
the loop pauses on a pending call exactly as it did before tools existed, which is what a subagent
given no tools needs.

**Tool results are stamped with the run that emitted the call**, not the run that settles it. That is
what makes a turn which paused and resumed produce a log identical to one that completed in a single
pass — the property the whole event-log design exists to protect.

**Resume is almost not implemented.** `resume` *is* `runTurn`, because position is a pure function of
the log. Proven by serializing the log, discarding every in-memory object, rebuilding with a
different model script, and completing the turn. A durable pause is `return`.

The one thing it cannot derive is a turn stopped while the model still held the floor. An interrupt
mid-reply leaves `assistant-said { interrupted: true }` as the last turn-taking event, so
`awaitsReply` is false and the next `runTurn` returns `Idle` rather than answering the model's own
half-sentence. `resume` therefore appends a `nudge` — and only then, which `core/events/resumePlan`
decides. Every other stopping place already gives the loop somewhere to go: a failed step appends
nothing, a call the developer stopped before it ran is settled as denied, and one aborted in flight
gets a result carrying the abort, so all three tails are turn-taking and resume appends nothing at
all. `nudge` is what makes this cost one event rather than a second record of loop position: it is
in the prompt for `lifetimeSteps` model steps and then gone, so a resumed turn leaves a log a
completed one could also have produced.

A call the loop recorded but never dispatched — a later batch that the abort reached first — is
re-dispatched by resume, which is correct rather than a hazard: `settlePending` only skips runs it
never entered, so nothing that started is missing its result. That is the same shape rewind refuses,
for the opposite reason: rewind is undoing the call, resume is completing it.

**A step's calls settle in batches, not one at a time.** `settlePending` folds the pending calls
into runs of consecutive concurrency-safe ones — each unsafe call a run of its own — and dispatches a
run with `Promise.all`. **An unsafe call is a barrier**, so reads either side of a write never join
across it. Results are appended in call order once the whole batch has drained, whatever order it
finished in, and each is still stamped with the run that emitted its own call. Two consequences worth
naming: the model prompt is unaffected, because `messagesFromEvents` already matches settlements to
calls by `callId` rather than by log adjacency; and with no tool declarations to consult, every call is
unsafe and the loop settles sequentially exactly as it did before, which is what keeps every existing
test honest.

**A batch keeps the results of calls that ran before an approval earlier in the same batch.** Drafts
are appended per call in ordinal order and the run is only then scanned for an `approval-requested`, so
a pause on call 2 leaves calls 3 and 4 already settled. Nothing happened without approval: a batch holds
only concurrency-safe calls, and the effect rule below means none of those can change the world. The
shape that would be wrong — a write already applied behind an unapproved call — is unreachable, because
a Write or Destructive call is always a batch of one.

**There is no concurrency cap.** Admission is the safety predicate and nothing else, which is what
Claude Code's streaming executor settled on after its legacy path capped at ten. A cap would only ever
bite a step the model deliberately fanned out, and every call in a batch is read-only by construction.

**Concurrency safety is a property of the parsed input, not of the tool** — `read` of a file is safe,
and a future `bash` of `ls` may be while `bash` of `rm -rf` is not. It is declared as an optional
`isConcurrencySafe(input)` on `ToolDefinition`, defaults to unsafe, and fails closed on a schema-parse
failure or a throwing predicate. **Effect outranks the predicate**: a Write or Destructive tool is
never batched even if it declares itself safe, because `dispatch` snapshots the workspace before such a
tool runs and a snapshot must mean "the tree before this call" — two of them in flight capture each
other's half-applied writes and rewind stops being true. That guard is also what keeps two `write`
calls to one path out of a single step, which the read-before-write hook could not see, since hooks are
handed one call at a time rather than a batch.

**Partitioning necessarily reads pre-hook input.** It happens before `dispatch`, so a `BeforeTool` hook
that rewrites input cannot move a call between batches. Accepted: the parse it runs is the tool's own
schema, and the alternative is dispatching to learn whether dispatch may be parallel.

**`bash` stays unsafe in every form, including backgrounded.** The classifier that will answer "may
this command run concurrently" is the same shell parse that answers "does this command need approval",
and there should be one of it, not two.

## Background shells

A command the model backgrounds returns a shell id immediately and keeps running after the turn that
started it ends. `bash({ runInBackground: true })` registers the process with a session-scoped
`ShellRegistryPort`; `shell_output` reads what it has printed since the last read, `shell_list` says
what exists, and `shell_kill` stops it. The developer gets the same three through the sidebar's SHELLS
section and the `ctrl+t` panel, which reads a shell by `peek` rather than `read` so that looking at one
never consumes output the model has yet to see. The panel scrolls that peek: it holds the last 64k
characters, wrapped to at most a thousand rows, in a scrollbox that sticks to the newest line until a
reader pages away from it. That window is shorter than what the registry retains because every row is a
renderable the tail rewrites each time the shell prints. `harness/src/shells/` owns the lifecycle and the bash tool is a caller, which is why the
process primitives live there rather than under `tools/builtin/`.

**Output is buffered in memory behind a byte cursor, not written to a file.** Claude Code hands the
child an fd and tails the file, which buys it a process the harness need not stay alive to drain; Atlas
already drains the pipe incrementally for the foreground path, so a bounded ring buffer per shell costs
one module instead of a temp directory, an `O_NOFOLLOW | O_EXCL` open against planted symlinks, a
size watchdog and unlink-on-exit. What it costs instead: output beyond the retained window is dropped
rather than paged from disk, and a read reports how many characters it lost rather than pretending the
gap is not there. A shell that prints past a hard overflow cap is killed, because nothing else bounds
the decoder.

**Completion is pushed, and reaches the model as an event of its own.** The registry queues one ending
per shell — guarded by a flag, so a completion is announced once — and the composition root drains it
through the same `drainPending` seam the composer's typed messages use, now widened from `string[]` to
`EventDraft[]` so the two can differ in kind. The ending is a `background-shell-ended` event carrying
the shell's output, not a `user-said` carrying a sentence about it: a `user-said` puts words in the
operator's mouth and renders as their message, and a notice saying "read it with `shell_output`" spends
a whole model step fetching bytes the harness already held. `context-loaded` looks like the right event
and is not: the projection renders only the **latest** event per `(slot, key)`, so keying on the shell id
would let a completion notice supersede that shell's earlier stall notice and erase it from the model's
view. `context-loaded` means "here is the current content of X" — right for CLAUDE.md, wrong for a
stream of point-in-time events about one shell.

**The delta is read when the ending is handed over, not when the process exits.** Consuming the buffer
in the exit callback reads as the obvious place and is wrong: an ending that is dropped rather than
delivered — `forgetNotices` when a new conversation opens — would take output nobody had seen with it.
So a queued ending holds its snapshot and a closure that takes the delta, and `drainNotifications`
is what advances the model's cursor. Until something drains, `shell_output` still finds the output.

**Nothing times a background shell out.** A quiet shell is not a stuck one — a test suite can run for
minutes without printing — so there is no threshold, no sweep and no timer. What survives is the signal
that was actually diagnostic: output ending *without* a newline on a prompt-shaped last line, which is
what a process waiting on stdin leaves behind. That is computed on demand as `awaitingInput` on the
snapshot rather than announced, so it informs `shell_list`, `shell_output` and the sidebar without ever
interrupting a command that is merely slow. Its stdin is closed, so nothing can answer it; every place
that surfaces it says to kill it and re-run with input piped in.

**Every ending notifies, and the model does not get a say.** There was a `notifyOnExit` axis —
`always` / `on-failure` / `never` — and it is gone. An option nobody should choose should not exist:
a model that opted out of hearing about a shell reasons about a dev server that died ten minutes ago,
and a shell a *human* killed is the case where the model most needs telling and the one an
outcome-shaped policy stayed quietest about. So a kill notifies, a failure notifies, a clean exit
notifies, and teardown notifies.

**An ending that finds no turn running starts one.** `drainPending` is consulted inside a running turn,
which covers a shell that ends mid-flight — the loop drains it on its next pass, and it stands under
the working indicator in the meantime, queued like a typed message but read-only, because nobody typed
it. Idle is the case that needed a mechanism: the registry is an external store, the composition root
subscribes with `onNotice`, and an ending arriving while no turn is running drives one. That is why the
tool prompt can promise immediacy rather than eventual delivery. A witness on the waking effect keeps a
turn that dies before its first drain from spinning there.

**Teardown records what it kills.** Closing the session kills every background shell, and those endings
are worth keeping — reopening the conversation should say where the dev server went. Nothing is left
running to drain them, so `close()` runs `closeAll()`, drains, and appends to the thread the session was
last on before the database goes. This is the one place the registry's thread-blindness shows: endings
carry no thread, so opening a new conversation forgets what is queued rather than landing it in a
conversation that did not start the shell.

**Reaping is by spawner, not by process tree.** A backgrounded shell is meant to outlive its turn, so
only the session that started it knows when nobody is left to read it: container teardown kills the
whole group. Shells do not survive the process — the registry is memory — which is the one
place this deliberately stops short of Claude Code, whose tasks survive a session and a `/clear`.

**A sub-agent is this function called recursively** with different arguments — tools, policy, budget,
thread. Nothing per-run belongs in the DI container; wanting a child container is a smell that
run-varying config got injected instead of passed. Every event carries `runId`, `parentRunId`, and
`depth` so nesting is never foreclosed.

## Compaction

A long conversation walks into the context ceiling, so `assemble` re-deriving the whole prompt from the
log every step is not sustainable on its own. Compaction is what bounds it, and the shape it takes is
decided by one question: does it destroy the rows it compacts?

**One thread, one log.** The log *is* the thread, so every operation that adjusts context acts on the
current log rather than producing a second conversation. Rewind truncates it. Compaction replaces a range of it with a summary.
A sub-agent may inherit its parent's prefix **by reference**, which is safe precisely because that child
is read-only over the inherited rows and its depth is bounded by agent nesting rather than by how many
times a human pressed undo. **Inheritance is the spawning agent's decision, not a property of sub-agents**
— a sub-agent sent to read one file wants an empty log, while one continuing the parent's line of work
wants the context already in it, and only the caller knows which. So the mode is an argument at the spawn
site, and `EForkMode` is the vocabulary for it.

**Forking is the only operation that copies**, because it is the only one whose output is a second
conversation the user can reach and keep. Copying anywhere else buys storage nobody can navigate to:
thirty rewinds of a multi-megabyte thread is tens of megabytes of rows with no way to reference them.
So the operation is `ThreadStorePort.fork({ from, seq, mode, title })`, returning the new thread. It sits
on the thread store rather than the event log because it has to write the thread row and the event rows in
one transaction, which is the same reason `rewind` lives there. `EventLogPort.forkFrom` — which only ever
threw — is gone, and `readOwn` takes its place beside `read`: `read` returns the composed view a reference
fork implies, `readOwn` returns only the rows the thread itself holds.

**A reference fork is not safe to hand a sub-agent yet, and this is the list.** The substrate works and
is tested, but two invariants the rest of the harness relies on stop holding the moment a child inherits
rows it does not own: `seq` no longer starts at 1, and `read({ threadId })` can return events whose
`threadId` is a different thread. An audit of every consumer found these, and the first two are the ones
that corrupt rather than merely mislead:

1. **The loop must read `readOwn` for control flow.** `pendingCalls` and `outstandingApproval` over a
   composed read see the *parent's* state. A sub-agent is forked from inside a tool call, so the spawning
   `tool-called` is unsettled at the fork point by construction: the child either pauses forever awaiting a
   tool it never called, or re-dispatches the spawning tool and forks again, bounded only by the 8-hop cap.
   Choosing a fork seq before the call does not help — a parallel batch leaves siblings unsettled at any
   seq. An inherited unanswered approval wedges the child the same way, because the answer can only be
   written on the parent above the fork point, where the child can never see it.
2. **A child must be seeded with its own `user-said` in the fork transaction.** `awaitsReply` reads the
   last turn-taking event of the composed list, so a child forked after the parent's `assistant-said`
   returns `Idle` without taking a single model step.
3. **Rewinding a parent below a live child's fork point punches a hole in that child.** Nothing refuses it
   and nothing queries `@@index([parentThreadId])`. Either refuse the rewind or materialise the child's
   prefix first.
4. **`Thread.parentThreadId` is a bare column with no self-relation.** There is no thread-delete path
   today; when one lands, a cascade would strip the parent's rows and the child would silently read as
   though it never had a parent. `onDelete: Restrict` costs nothing while there is no data.
5. **The TUI's fake event log cannot represent a fork**, so no composition test can catch any of this — it
   derives `seq` from array length and returns one thread's own rows.
6. Cosmetics, worth knowing: an untitled child's sidebar title, turn count and live tool calls all describe
   the parent, because `deriveSidebar` reads the composed list.

Rewind is already guarded: `rewindTarget` takes a `floorSeq` and refuses `BelowInheritedPrefix`, which
`rewindThread` derives from the thread's own first sequence — not from `forkSeq`, because a **copy** fork
records a parent link yet owns every row it holds and may legitimately rewind past the fork point.

**It does. Compaction deletes the rows it compacts and puts one `history-compacted` event carrying
`{ throughSeq, summary, replaced }` in their place, at the sequence the range ended on.** The transcript
therefore shows exactly what the model can read, which is the property that decided it: a UI that scrolls
back past the boundary is showing the operator a conversation the agent no longer has, and every question
"why doesn't it remember that" then has two possible answers. One record, one view.

What that costs, stated plainly: a compaction cannot be undone. The rows are gone, so rewinding past the
watermark is not a recovery path. The guard is the only protection, which is why it refuses rather than
truncates when a range is unsafe.

**`context-loaded` is exempt from the delete.** It means "here is the current content of X", not history,
so compacting it away would strip a thread's `CLAUDE.md` permanently — and `append`'s content-keyed
idempotency means an unchanged re-offer resolves to the row that is no longer there. The delete therefore
spares `context-loaded`, the assembly rule renders those messages *ahead* of the summary, and the
summariser's transcript render leaves them out so they are not duplicated into the prose. Instructions,
then the compacted history, then the live turns.

**Compaction has two anchors, and they are not symmetric.** A *prefix* compaction replaces the oldest
turns and puts the summary at the high end of the range it replaced, immediately before the survivors. A
*suffix* compaction — the operator pointing at a message and saying "summarise from here" — replaces the
newest turns and puts the summary at the low end, immediately after the survivors. `ECompactionAnchor`
records which, explicitly rather than by inference, because two things downstream need to tell them apart.

The first is the rewind floor. `compactedThrough` counts only prefix compactions: a suffix compaction
deletes the tail and leaves everything below it intact, so it must not stop the operator rewinding into
rows that are still there. The second is the guard. A prefix cut orphans a tool *result* whose call it
removed, which the provider rejects; a suffix cut strands a dispatched *call* whose result it summarised
away, so the next turn runs the tool a second time. Those are different failures found by different
projections, which is why `suffixCompactionTarget` is its own function rather than a parameter on the
first.

`compactedHistory` therefore splices each summary in at its own sequence rather than prepending. That is
what lets a prefix and a suffix summary coexist on one thread and each read in the right place, and it is
also why the rule needs no special case for `context-loaded`: those events carry low sequences and fall
ahead of a prefix summary on their own.

**Only the prompt is shortened; control flow is unaffected.** `pendingCalls` and `outstandingApproval`
read the log, and the guard refuses any watermark that would strip a tool call while keeping the result it
answers — so a compaction can never leave a dispatched call the loop would run twice. There is no
`splits-approval` refusal because approval events never render into the prompt at all.

**Compaction rewrites message content, which costs one cold conversation and nothing else.** Anthropic's
cache tiers are invalidated top-down: a message-content change drops the messages cache but leaves the
tools and system entries intact. Since `cacheBreakpoints` spends its expensive 1h marker on the last
system block, and compaction never touches `system`, the entry worth protecting survives. What does move
is every message-cache anchor after the watermark, because anchors are absolute positions counted from the
front — so expect one cold turn, and prefer compacting rarely and deeply over often and shallowly.

**Summarising is I/O, so it is not a rule.** `core/compaction` decides *whether* a watermark is safe
(`compactionTarget`) and *where* it should go (`planCompaction`); `harness/store/compact.ts` performs the
operation, and the summary itself comes from a one-shot model call shaped like the session titler.
`core/budget/resolveBudget` is the controller above the pipeline: it re-runs the pure assembly against
each rung of a recency ladder, measuring candidates by actually re-assembling them rather than by
arithmetic, and reports `fits`, `compact` or `exhausted`. It is built and tested; nothing in the loop
calls it yet, so compaction today is the operator pressing the chord.

**The system preamble says compaction happens.** A harness that compacts silently gets a model that
hoards context and rushes; one that says so gets a model that writes durable notes into its own output.

Server-side context management was priced and rejected for the primary path. Anthropic's `compact_20260112`
returns an opaque compaction block that must be echoed back on every request, which would put the provider
in charge of what the model sees and give Atlas a prompt it cannot re-derive from its own log — both
against the two rules. `clear_tool_uses_20250919` is cheap to reimplement as a pure rule if it is ever
wanted, and would then work on every provider.

## Three timelines

| Timeline | Owner | Restored by |
| --- | --- | --- |
| **Conversation** — messages, reasoning, tool calls, approvals | EventLog (SQLite) | move the thread head |
| **Control** — pending tool, retries, interrupt reason | *derived from the log* | re-read the log |
| **World** — files, git index, worktree, subprocesses | Workspace snapshots (git objects) | restore the snapshot on the event |

The middle row is where frameworks want to sell you a checkpointer. We don't have one because we
don't need one.

`rewind(eventId)` resolves the event's `snapshotId`, restores the workspace, and moves the thread
head. Fork is the same operation writing to a new `threadId` — one row, because context is derived.

Snapshots cannot undo non-filesystem effects, so tool dispatch takes
`idempotencyKey: ${runId}:${callId}`.

### Where the session is, is Conversation

There are two directories, and they answer different questions.

The **project directory** is fixed for the life of the process. It anchors `.atlas/settings.json`,
project skills, the instruction-file descent, and — the load-bearing part — every relative path a
tool is given. The **session directory** is where a bash command starts, and `cd` moves it.

Tool paths resolve against the *project* directory, not the session directory. This is a deliberate
departure from Claude Code, which resolves them against the session cwd. Rewind is the reason: a path
resolved against a cursor the conversation can move means a different file when the same log replays
from a different point, and the log is supposed to be the one record. `ResolveProjectPathsHook` makes
every declared `EPathForm.Absolute` field absolute at `EStage.Guard, nudge -1` — before anything
downstream keys on a path, so read-before-write cannot see the same file under two spellings.

The session directory is not held anywhere. It is `sessionDirectoryOf(events)` — the last
`cwd-changed` in the log, or the project directory when there is none. That places it in the
Conversation row, which is the only reason rewind, fork and resume agree about it without a second
record to keep in step. A mutable holder in the container would have been the checkpointer the two
rules exist to refuse.

Shells are spawned fresh per call, so nothing in the process survives it — an exported variable, a
shell function, a background job. The directory survives because the harness tracks it out of band:
the tool spawns into the session directory, recovers `pwd -P` through a probe file, and reports the
move as tool output that an `AfterTool` hook turns into the event. A command that calls `exit`, or
dies under `set -e`, never reaches the probe, and the session simply stays where it was.

Both sides of the comparison go through `realpath`, for the reason path handling always does here:
`/var` and `/private/var` name one directory, and a string compare reports a move on every command
run under a temporary directory.

**The prompt is split along a static/live seam.** The system prompt names only the project directory,
because `cacheBreakpoints` puts a 1h breakpoint on the last system block and a directory that changed
inside it would cold-start the whole prefix on every `cd`. The live session directory rides the
Conversation instead: `sessionDirectoryBlock` appends a reminder at the *tail* of the messages, where
invalidation is cheap, and only while the session sits somewhere other than the project directory.

It is a rule over the log rather than a `context-loaded` event on purpose. An event renders at its own
seq, so a move at seq 13 of a 133-event thread scrolls away and the model is left inferring its own
location — which it answers by defensively prefixing `cd <abs> &&` onto every command. Supersession
would not have saved it either: it is keyed on `(slot, key)` in the projection and on a content digest
in the store, so an A→B→A walk cannot re-file the notice at the tail.

Neither directory walls the filesystem off. There was a containment guard that refused any declared
path outside the project directory, and it was deleted rather than kept: `bash` declares no path
fields, so it never applied there, and an agent that can `cat` a file it may not `edit` is being told
which tool to use, not being made safe.

**Two stores sit outside all three timelines, and neither is ever read back to rebuild state.**

The **spend ledger** is one `Turn` row per turn: token counts in four tiers, the model that billed
them, the terminal status, and the span. It is accounting, so it is deliberately not a timeline — no
rewind consults it, and a failed write is reported and swallowed rather than failing the turn. It
stores tokens, never money: cost is derived from the counts and `modelId` at read time, so a
corrected rate applies to history instead of only to turns run after the correction. Cache reads and
cache writes are counted *inside* `inputTokens` rather than on top of it, which is why
`contextTokens()` sums input and output alone and the ledger keeps all four tiers — "how full is the
window" and "what did this cost" are different questions over the same numbers.

Recorded status is a plain string, not `ETurnStatus`, and that is load-bearing twice over. A turn
that throws out of the loop records `crashed`, which is not a `TurnOutcome` any caller can return —
conflating it with `Failed` would make the ledger lie about whether the turn ended or died. And the
ledger settles from a `finally` around the loop rather than before each `return`, because the loop
has nine terminal exits and a tenth is one refactor away.

The **raw tape** is every provider stream part, verbatim, as JSONL — tapped *above* `toCoreChunk`, so
a part the conversion drops to `null` is still recorded, which is the failure class the tape exists to
catch. Off unless `ATLAS_RAW_TAPE` is set, one file per process, closed by the disposal registry
rather than by the stream function that taps it. It rotates at a segment cap instead of falling
silent, and marks its own ending: `rotated` names the next segment, `closed` means orderly teardown,
and no marker at all means the process died hard and a flush window is missing. Nothing reads it
back — it exists because the conversion layer is ours, and `core-contract.md` already documents two
traps in it that are only diagnosable against the original bytes.

## Durable events vs streaming

Durable events are **coarse** — one `assistant-said` per model step, not one per delta. Writing every
token to SQLite is absurd.

Live streaming goes to an in-memory channel the UI subscribes to, replaced by the durable event when
the step completes. So the UI has two inputs: the log (history, authoritative) and the delta channel
(the current step, ephemeral). `OnChunk` hooks run on the channel — which is why redaction ordering
there is a security constraint, not a preference.

An append that closes no step still says so, as `events-appended`. Otherwise a message steered into a
running turn is durable the moment the loop drains it but invisible until the next step ends, and the
operator watches what they sent disappear for the length of a model call.

## Startup

The renderer comes up **before** the harness does. `bootAtlas` starts `openSession` — compose the
container, read credentials, register grammars, open the conversation — and then, without waiting on
it, creates the `CliRenderer` and renders `BootScreen`. What fills the terminal for the length of the
boot is the curtain, not an empty screen and not a half-built workspace.

Two ordering rules hold that together, and both are load-bearing.

**Appearance is applied before anything mounts.** `openSession` resolves the accent and the block
density out of the settings snapshot and writes them into the live palette while it still holds the
terminal alone. Applied from an effect instead — which is what `useSettings` alone did — the first
committed frame paints in the shipped clay at comfort density and the next one corrects it, a
whole-screen repaint of a screen the operator has already started reading. `useSettings` still
applies appearance on every change, because a setting edited at runtime has to land; it is a no-op
when the value is already the one in force.

**The workspace mounts under the curtain, not after it.** `BootScreen` renders `<App>` as soon as the
session is ready and holds the curtain over it until the ink has laid down and the workspace has had
a beat to settle. So what the curtain hides is real settling — sticky scroll finding the bottom,
tree-sitter highlighting arriving off-thread — rather than work deferred until someone can watch it.

`<App covered>` takes the composer's focus with it: the terminal cursor is not part of the character
grid, so a focused textarea would draw its caret straight through the curtain. It swallows keys for
the same reason — while the curtain is up the only key that reaches anything is the one that lifts
it. Before the harness exists nothing can lift it at all, because there would be nothing behind it;
only ctrl+c is answered there, since the renderer holds raw mode from the first frame and a boot that
hangs must still be abandonable.

`ui/startup-model.ts` owns the choreography as pure data — ink, hold, lift, gone — so the timing is
tested without a terminal, and `Startup` only draws whatever frame it is handed.

## Credentials and accounts

Atlas holds **accounts**, not a credential. One per login, several per provider, each with a status
and a label, and one of them marked as the one that answers for its provider. `AccountStorePort` in
`core` is the contract; the vault is `~/.atlas/auth.json` at mode 0600, written temp-and-renamed,
with every secret sealed by aes-256-gcm under `~/.atlas/key`. A file rather than the OS keychain,
because the keychain is one platform's and the vault is not.

**The model port asks for a credential per request.** `createAnthropicOauthModel` resolves one inside
`doStream`, so a token that goes stale mid-session is refreshed by the next step rather than failing
the turn — nothing above the port has to know a refresh happened.

Four decisions are pure and live in `core/credentials/`, tested with plain data:

- `refreshDecision` — fresh, due inside a five-minute skew, or unrefreshable.
- `adoptionOf` — whether a pair observed elsewhere is newer, ours, and worth keeping. Ported from the
  previous TUI, where the missing case cost a week of dead accounts.
- `chooseAccount` — which account answers. An `expired` account is ranked last but never excluded,
  because a refresh is the only thing that clears that status and excluding it makes the door
  one-way.
- The provider registry — what each provider supports and how one signs in to it. Anthropic is
  wired; OpenAI's device-code flow and OpenRouter's API key are declared and answer `reachable:
  false`, which is what the switcher reads as `⚠ no key`.

**A refresh token is single-use.** The server rotates it, so two callers refreshing one account race
and the loser gets a 400 that reads exactly like a dead credential. `RefreshingCredentialPort` keeps
one in-flight refresh per account, keyed by id and dropped the moment it settles — it is not a cache.
A hard 4xx marks the account expired; anything else falls back to the token in hand if it still has
life, because a socket hang-up is not an authentication failure.

**A credential imported from another tool is written back to it.** Atlas takes up an existing Claude
Code login on first run, so nobody is asked to sign in twice — but refreshing it would leave the
`claude` CLI holding a pair the server has already invalidated. So an imported account remembers its
source, and the rotated pair goes back the way it came, guarded by `adoptionOf` in both directions:
Atlas takes up a pair Claude Code refreshed first, and never pushes an older pair over a newer one.

## Packages

```
atlas/
  packages/
    core/       pure. no I/O, no clock, no randomness, no network, no database
    harness/    the loop, hooks, tools, model adapters, credentials, store
  apps/
    tui/        OpenTUI + React, and the composition root
  docs/
  deprecated/   frozen reference: the previous TUI, the never-run agent-engine and the codex-sdk
                client, and the paused backend/web/shared cloud stack with its CI and infra
  .spikes/      four reference implementations (gitignored)
```

`deprecated/` is not a Bun workspace member. It is read for prior art and never imported.

`core` performs **no I/O**. When something is hard to test, that is the signal to move the decision
into `core`, not to add a mock. `tui` never imports `store` or `providers` directly — it talks to
`harness` through its ports, and the composition root is the only place that knows which
implementation is bound.

Three packages, not five. A package boundary is worth it only where the compiler should enforce a
dependency rule: `core` has no I/O, `harness` is importable without a terminal. `store` and
`providers` stay folders until something forces them out.

### Folder structure

```
packages/core/src/
  events/        Event union, EventDraft, envelope, branded ids
  events/        projections: pendingCalls, outstandingApproval, answeredApproval
  assembly/      Assembled, Rule, Annotator, RuleContext, assemble, trace, AssemblyPipeline
  assembly/      exchange-shape: the faults a provider would reject, reported not thrown
  assembly/rules/        content policy — compacted history, thinking tail, loaded context, images
  assembly/annotators/   cacheBreakpoints (built); provenance (not built)
  budget/        resolveBudget: the fixpoint controller (pure: takes a rebuild function)
  compaction/    the watermark guard, the range plan, the summariser's transcript render
  hooks/         phase types and outcome types only — no container
  policy/        BeforeTool severity resolution, the approval resolver, tool-call partitioning
  tools/         ToolCall, ToolOutcome, EToolEffect, EContentAccess, definition types
  ports/         EventLogPort, ModelPort, WorkspacePort, CredentialPort, AccountStorePort,
                 ClockPort, IdPort, SettingsStorePort
  credentials/   accounts, provider specs, and the pure decisions: refresh, adoption, selection
  settings/      definitions, layered resolution with provenance, edit operations, the registry
  message/       Atlas's own message type (see below)

packages/harness/src/
  loop/          runTurn, settlePending
  model/         ModelPort over AI SDK; the stream accumulator
  model/providers/   LanguageModelV4 impls: claude-oauth, codex-oauth, api-key
  credentials/   the account vault, the refreshing CredentialPort, OAuth clients, and the
                 sources a login can be imported from and written back to
  files/         what the model has seen of each file on disk, for the read-before-write guard
  store/         Prisma event log, thread heads, workspace snapshots
  tools/         registry, dispatcher, builtin tools
  shells/        background shell registry, process-group lifecycle, delta output buffers
  hooks/         hook implementations — claude-md injection, read-before-write,
                 file-state recording, approval policy
  settings/      SettingsStorePort backends: user and project files, in memory; the layer service
  workspace/     git snapshot and restore
  discovery/     glob at dev time, generated manifest for --compile

apps/tui/src/
  main.tsx
  composition/   the container bootstrap — the only place bindings are chosen
  store/         ConversationStore: log + delta channel → useSyncExternalStore
  ui/            components, pages
  ui/markdown/            segmenter, prose, tables, fenced blocks; the renderer registry
  ui/markdown/renderers/  one FencedRenderer per fence kind: diff, lexical, code, plain
  ui/markdown/grammars/   tier-1 highlighting: parsers-config.json, vendored wasm, generated loader
  ui/markdown/lexical/    tier-2 highlighting: the scanner, the rule primitives, one spec per language
  ui/markdown/themes/     capture name → semantic role → colour, for both tiers
```

Max 300 lines per file. Tests in a sibling `__tests__/` as `*.spec.ts`.

## Decisions

| Concern | Decision |
| --- | --- |
| Loop substrate | **Hand-rolled.** No LangGraph, no Mastra |
| Canonical record | Append-only event log — `messages[]` with types |
| Prompt | Derived per step by `assemble`; never accumulated |
| Checkpoints | None. Position is derived |
| Storage | Prisma 7 + `prisma-adapter-bun-sqlite` |
| Model layer | AI SDK, `streamText` one step, as normalization only |
| Provider interface | `LanguageModelV4` |
| Context operations | Ours, model-agnostic |
| DI | **tsyringe.** Class tokens, `@injectAll` for the hook and tool sets — see `.scratch/tsyringe-di/spec.md` |
| Hook discovery | Glob at dev time, generated manifest for `--compile` |
| Packages | `core`, `harness`, `apps/tui` — raw TS source, no build step |
| Runtime | Bun — runtime, package manager and test runner |
| Task runner | **Turborepo.** `turbo run typecheck \| test \| build`; per-package scripts stay `tsc` / `bun test` |
| Fenced-code highlighting | **Two tiers.** tree-sitter wasm where a small maintainer build exists; a declarative lexer for the long tail |

**`core` owns its own message type.** `Assembled` cannot hold `ModelMessage` without `core` depending
on the AI SDK, which would make model-agnosticism aspirational rather than real — and AI SDK ships
V2/V3/V4 simultaneously, so `core` would churn on their versioning. The type is deliberately *thin*
and structurally close to `ModelMessage`, with
`providerOptions: Record<string, Record<string, JsonValue>>` passed through opaquely, so conversion in
`harness/model/` is near-identity and no provider capability needs modelling in `core`. The nesting is
load-bearing rather than incidental: a flat `Record<string, unknown>` is not assignable to the SDK's
provider options, so conversion would need a cast or a validator, and it leaves the metadata merge
ill-defined at exactly the depth where the signature lives. **That passthrough must never be dropped** — Anthropic thinking signatures ride
in it, and losing them fails silently.

**Syntax highlighting is two tiers, and the tiers must not overlap.** A tree-sitter language costs
0.2–3.3 MB of `.wasm`, committed and embedded in `bin/atlas` by `bun build --compile`. That price is
worth paying where a parse tells you something a token stream cannot — which type a name refers to,
whether `<T>` opens a generic or a JSX element. It is not worth paying forty more times for languages
whose highlighting is entirely lexical, and for most of them the question is moot: their maintainers
publish no `.wasm` at all.

So `apps/tui/src/ui/markdown/lexical/` holds a second highlighter — a pure single-pass scanner over a
declarative `LanguageSpec` of comment forms, string forms, keyword sets and an identifier alphabet,
about a kilobyte of source per language. It is not a fallback for tier 1's failures; it is the right
answer for a token-shaped language.

The seam that makes this cheap already existed. A tree-sitter highlight pass returns
`[start, end, captureName]` triples and the theme maps `captureName` to a colour, so the lexer emits
the same triples under the same nvim-treesitter names and inherits every theme unchanged. Adding a
theme still means editing one file. `lexicalRenderer` is registered ahead of `codeRenderer` in the
fenced-renderer registry, because the code renderable claims every non-empty language; a test in
`lexical/__tests__/registry.spec.ts` holds the two language sets disjoint so a lexical spec can never
silently outrank a real grammar.

The lexer is also synchronous, which the tree-sitter path is not. A `CodeRenderable` clears to plain
text and paints its highlight a worker round trip later, so a streaming fence flashes; a lexical fence
has no round trip to wait for.

## Adopted from the rejected options

- Mastra's `BeforeStep` / `BeforeRequest` split — the first persists to the record, the second is a
  transient per-provider rewrite. Our contract had conflated them.
- Mastra's approval-suspend payload shape.
- LangGraph's hard lesson: nothing derivable goes in durable state. Its predecessor in this codebase
  had a `@deprecated` field it could not delete because live checkpoints contained it.

## Why tsyringe and not Nest

The extension domain is **sets** — hooks per phase, tools in a registry — and tsyringe has `@injectAll`
as a primitive. Nest has no multi-provider, so a set is emulated with
`{ provide: HOOKS, useFactory: (...i) => i, inject: classes }`: untyped, order-coupled, and edited once
per set member, which is exactly the one-file property the hooks spike was measuring. Module
encapsulation would redraw a boundary `core` / `harness` / `apps/tui` and their barrels already enforce.
And Nest's optional peers do not bundle — `bun build --compile` needs eight `--external` flags, and each
upgrade can add another.

Startup cost is not the argument. The spike measured ~50 ms for the Nest import, and Atlas is a
long-lived process that amortises it away.

What Nest would have given us is ordered teardown. tsyringe has no lifecycle at all, so disposal is an
explicit registry the composition root owns.

**Ports are `abstract class`, not `interface`,** so the token *is* the contract — no symbol table, no
stringly-typed `@inject`. `core` therefore emits runtime values, which costs it nothing: still zero
dependencies, still no I/O.

**The one async edge stays outside the container.** `container.resolve()` is synchronous and tsyringe
has no async provider. The graph has exactly one await — `openAtlasDatabase` in
`harness/loop/build-harness.ts` — so the root opens the database, registers it and the config as
`useValue` tokens, and resolves the rest in one synchronous call.

## Deferred, deliberately

Phases and phase briefs, thread delegation, session rotation across accounts, MCP server lifecycle,
skills precedence against `CLAUDE.md`, container/sandbox isolation, PR shipping. Each is an assembly
rule, a hook, or a port implementation — none requires reopening a decision above.

Known gaps in the contract, accepted: a hook cannot fail the turn or annul a tool result, and hooks
see one call at a time rather than a batch.
