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
running to drain them, so `close()` runs `closeAll()`, then drains and appends per owner before the
database goes.

**A shell belongs to the thread that started it.** The registry is one object for the process, but every
read is scoped to an owner: `start` records the thread, and `list`, `read`, `peek`, `kill`,
`pendingNotices` and `drainNotifications` all take one. A conversation is therefore never told about,
and cannot kill, a shell another conversation is running — the model asking `shell_list` in B does not
learn about a `bash_3` it never started. Endings route to the owning thread's log rather than to
whichever turn drains first, which is why switching conversations keeps a queued ending instead of
discarding it. Two reads stay deliberately global: `listEverywhere`, because the exit guard must name
every shell that quitting would kill whoever started it, and `closeAll`, because the process dying takes
them all.

**Reaping is by spawner, not by process tree.** A backgrounded shell is meant to outlive its turn, so
only the session that started it knows when nobody is left to read it: container teardown kills the
whole group. Shells do not survive the process — the registry is memory — which is the one
place this deliberately stops short of Claude Code, whose tasks survive a session and a `/clear`.

## Sub-agents

**A sub-agent is a first-class Atlas thread that Atlas spawned**, not `runTurn` called recursively
with different arguments. It has its own thread row, its own event log, its own loop and its own context window;
it runs in the background; it stands in the sidebar while it runs; and the operator can open it,
read it and type into it exactly as they read the main conversation. Every one of those properties
is already true of a background shell, which is why `harness/src/agents/registry/` reads as a
sibling of `harness/src/shells/` — the notice queue, the wake path, the ownership scoping and the
exit guard are the same machinery over a thread instead of a process. When a question here has no
answer, the answer is almost always whatever `ShellRegistryPort` does.

**Two things distinguish a child from the main agent, and there are no others.** Its tool group:
`toolRegistryFor` narrows the registry to the agent type's own allow/deny lists, and
`withoutAgentTools` then denies all five of `AGENT_TOOL_NAMES` on top. Its system prompt:
`subAgentPrompt` compiles the fragment registry with `EPromptAgent.Sub` and prepends the agent
type's own prose, which stands in place of the identity fragment — `AtlasIdentityFragment` is the
only fragment that reads the axis, and it is Main-only, so a child never reads "You are Atlas" and
never reads instructions about a tool it does not have. Everything else — the loop, the hooks, the
workspace, the write access — is identical.

**There are no read-only agent types, and that is a decision rather than an omission.** `explore`
and `reviewer` are briefed by `REPORT_ONLY_CONTRACT` not to change anything, and nothing enforces
it: `maxEffect` is plumbed all the way through `filteredToolRegistry` and deliberately left unset on
every built-in. The read-only guarantee is a **briefing, not a mechanism** — say so out loud,
because the plumbing's existence otherwise reads as enforcement. What it buys is that a reviewer
which finds a one-line fix can simply be told to make it, instead of reporting a fix somebody else
has to apply.

**What the model has seen of a file is per thread, and delegation is what forced it.**
`ToolCall` carries a required `threadId` and `FileReadStatePort` keys its views on
`{ threadId, path }`, so a child reading a file no longer vouches for its parent's write. Sharing
one map meant a sub-agent's read satisfied the read-before-write guard on a thread that had never
seen the file — the guard reporting a fact about a conversation that did not hold it.

**The guard is three separate properties, and one verb does not cover them.**

*Exclusion, which eliminates the agent-versus-agent race.* `withPathLock` is a per-path in-process
async mutex, and `FileWriteGuardPort.underLock` takes the lock, re-verifies against **that thread's**
recorded view, and only then writes — the whole read-modify-write inside the lock, rather than a
decision in the hook and a write in the tool with nothing holding the file between. Because every
sub-agent runs in this one process, that closes the race outright rather than shrinking it. It is
proven concurrently and not sequentially: two writes raced through `Promise.all` yield exactly one
success and one refusal.

*Detection, which closes the content-blind predicate.* `FileView` carries a `digest`, and
`movedSince` consults it only when `mtimeMs` and `size` both agree — precisely the coarse-filesystem
case the old predicate missed, where a same-size edit inside one timestamp tick read as unchanged.
Unconditional rather than size-thresholded, deliberately: a threshold would put a silent hole on
exactly the large generated files a formatter is most likely to rewrite. Measured at 0.8 ms on a
10 MB file, against tool calls in the tens of milliseconds.

*Neither, for a concurrent external editor.* That one is only **narrowed**. No in-process lock can
see another OS process, and a pre-rename re-stat was deliberately not added — it would shrink the
window to a syscall gap and never to zero, which is a worse trade than saying plainly that the
window exists. `writeFileAtomically` is a fourth thing again, solving neither: it guarantees no
reader sees a half-written file and that a throwing write leaves the original intact.

**`movedSince` is the single definition of "this file moved"**, shared by the hook and the
write-time re-verification so the two cannot drift into disagreeing about staleness — which would
be the worst outcome, a guard that refuses one path and permits the other. One residue is
accepted: a blind `edit` of a file nothing has read has no recorded view to judge, so the guard
must allow it. The lock still applies, so two concurrent blind edits both land rather than one
being silently lost.

The rest follows structurally from being a thread: a thread row carrying
`agent: { spawnedBy, type }`, a fresh log whose first row is its own `user-said` carrying the brief,
supervisor-driven stepping that nobody awaits, its own `AbortController` replaced at the top of each
step, a per-child steering queue drained as `user-said` at the loop's own drain boundary, and an
ending that lands on the **parent's** log carrying the child's final prose.

**Depth is capped at one by construction, not by a counter.** Denying the agent tools is the whole
mechanism: `filteredToolRegistry.find()` returns `undefined` for a denied name, so a child that
emits `agent_spawn` anyway takes the dispatcher's unknown-tool path and is told, truthfully, which
tools it actually has. Nothing counts hops and nothing needs to. The envelope still carries
`runId`, `parentRunId` and `depth` — they are load-bearing for run provenance — but "nesting is
never foreclosed" is no longer the design. Recursion was foreclosed on purpose.

**Nothing per-run belongs in the DI container; wanting a child container is a smell that
run-varying config got injected instead of passed.** A child's `LoopTurnRunner` is constructed at
spawn time with its own registry, dispatcher, model and assembly, exactly as
`PublishingTurnRunner.runnerFor` already does per call. The supervisor holds a *thunk* for those
deps rather than the deps themselves, because `agent_spawn` is a `ToolDefinition` the registry
constructs and resolving a child's tools eagerly would close the cycle.

### A delegate's work is counted, never quoted

This is the one rule inherited from legacy Atlas, and it was learned the hard way. The old harness
let a child's prose persist as the parent's own, because frames arrived interleaved on one stream
and transport was mistaken for authorship — a thread that delegated a fifteen-file sweep *in order
not to read fifteen files* ended up with all fifteen reads in its scrollback, and
`deprecated/tui/scripts/backfill-delegate-prose.ts` exists to delete what that bug wrote.

**Never append a child's events to the parent's log.** New Atlas is structurally immune — a child's
rows carry the child's `threadId` — and it must stay that way. What the parent gets is one
`agent-spawned` row, live counts on it, and one `agent-ended` carrying the child's final prose.

**The same rule has a second door, and `agentEndingsBlock` is what shuts it.** Twenty children
finishing is twenty `agent-ended` rows each carrying prose, and rendering all of them verbatim is
the context blowup arriving from the other side. So the rule groups *contiguous* endings into a
wave and renders one `<agents-ended>` block per wave, spending **one shared prose budget** across
it: endings are allotted shortest-first, each taking at most an equal share of what is left, so a
short report is never clipped and the remainder concentrates on the long ones. A clipped report
says how many characters went and why. The headline states the count and then says the quiet part
out loud — none of the children's own steps are in the parent's history and none are coming, so
what is quoted here is all of it. Two endings carry an extra sentence of advice, because the status
alone invites the wrong response: one the user stopped, and one that was lost.

**A wave is spliced in at its anchor, not appended after the conversation.** `mergeBySeq` places
each block at the seq of the last ending it collapses, so the report sits where it happened,
between the turns either side of it. There was never a trade-off between conversational placement
and wave collapsing — a per-event rule would have had the first and structurally could not have had
the second.

**Its slot in `defaultRules` is load-bearing in both directions.** It runs *after*
`messagesFromEvents`, because it merges into `input.messages` and there is nothing to merge into
before that. It runs *before* `compactedHistory`, because the block carries the anchor ending's
seq: placed after, an ending that compaction had already replaced would be spliced back in on top
of the summary that replaced it, and the same report would return forever. Both were verified by
perturbation, not by reading.

**`agent-spawned` renders as nothing, deliberately.** It is not in `TURN_TAKING` and no rule emits
it. The `agent_spawn` tool result already told the model what it started, and a second telling is
noise in the one place noise is most expensive.

**What it has out is stated once per step, rather than left to be asked for.** `agent-spawned`
renders as nothing and an ending has not arrived yet, so between the two the parent held no standing
statement that six children were still running — and an agent without one builds it by polling
`agent_list`. Observed, with six audits out: it announced that it would stop polling and let the
agents wake it four times, each announcement in the same step as another `agent_list` call, because
a step carrying any tool call continues the loop and only a text-only step ends the turn. So
`runningAgentsBlock` appends a tail reminder naming the running children — the sibling of
`runningShellsBlock`, sharing `appendedAtTail` with it — and it states the mechanism rather than only
forbidding the poll: ending the turn *is* the wait, because an ending that lands while nothing is
running opens the turn that delivers it.

**The roster carries nothing that moves.** agentId, type and intent, and no turn count, no tool-call
count, no last tool; `agent_list` drops those same counters for a child that is still running and
keeps them for one that has ended, where the count is part of the report. So two looks at a working
child return identical bytes. That is the point: a status line that changes on every read is a
status line that earns another read, which is the loop the reminder exists to end.

### Two lineage axes, deliberately not one

`parentThreadId` / `forkSeq` / `forkMode` record a **fork**. `spawnerThreadId` / `agentType` record
**supervision**. They are different relations with different meanings and they are stored as
different columns with different self-relations (`ThreadFork` and `ThreadSupervision`, both
`onDelete: Restrict`).

Overloading one column for both was the tempting version and it is wrong in both directions. A
spawned child is not a fork: it inherits no rows, so `inheritedPrefixOf` must not walk to it — and
it does not, because it terminates on anything but `forkMode === EForkMode.Reference`. And a fork
is not a delegation: `/resume` lists the conversations the operator started, so `threads-model`
hides any thread carrying an `agent` while showing every fork, which one overloaded column could
not express. `ThreadStorePort.fork` accordingly nulls the agent fields on the thread it returns — a
fork of a child is a conversation, not a second child.

### Agent types

An agent type is a name, the `whenToUse` prose that teaches `agent_spawn` when to choose it, the
system prompt the child runs under, and optional `tools` / `disallowedTools` / `model` /
`maxEffect` narrowings. Four ship embedded — `general-purpose`, `explore`, `builder`, `reviewer` —
and `agent_spawn`'s description is generated from the registered set rather than written, because a
type the model cannot see is a type that does not exist.

Discovery is the shape `harness/src/skills/` already uses, sharing `splitFrontmatter` and
`resolveShadowing` with it: embedded built-ins, then `~/.atlas/agents/*.md`, then
`<project>/.atlas/agents/*.md`, project over user over built-in on a name collision.

**A definition that will not load is refused, not dropped.** A malformed file must not stop Atlas
booting, but silence is the wrong other extreme: the operator writes an agent type, it never
appears, and nothing anywhere says why. So `parseAgentType` returns an `EAgentTypeRefusal` —
empty, bad name, no description, no prompt, bad `max-effect`, unusable model, unreadable — and
`AgentTypeSource.load` returns `{ types, refusals }` rather than a bare list. `AgentTypeCatalog`
also reports what was `shadowed`, because a project type silently overriding a user type is the
other way to be confused about which prose is running. A *missing* directory stays silent, since
not having written any agent types is not a mistake; an unreadable one is a refusal.

**`model:` is honoured and validated**, which reverses an earlier deferral. The reasoning that
deferred it — `modelIsReachable` hard-codes Anthropic, so pinning is pointless — confused two
things: `compose.ts` already pins the titler and the summariser, so pinning works and the
constraint is only which vendor answers. A pin that cannot resolve takes the whole agent type as a
refusal, the same as a bad `max-effect`, rather than silently falling back to the parent's model.

`loadAgentTypes` maps `withoutSelfSpawn` over the result, which strips `agent_spawn` from a type's
allow-list and unions it into the deny-list. That is belt to `withoutAgentTools`' braces: the
resolver refuses it so no definition can grant it, and the child's registry refuses it so no
resolver bug can leak it.

### The supervisor

`AgentRegistryPort` mirrors `ShellRegistryPort` member for member, so the TUI's wake path, notice
draining and exit guard understood it before it existed. Five facts about the implementation are
worth knowing because they are decisions rather than mechanics:

**A step is never awaited.** `spawn`, `say` and `resume` return the moment the child exists or the
step is scheduled; `ChildSteps` tracks the promise only so it cannot reject unobserved. `spawn`
awaits exactly one thing — the child's thread and its seeded brief — because the id it returns must
be real.

**Every read is scoped to the spawner**, exactly as a shell is scoped to its owner. A thread cannot
see, steer or stop a child it did not spawn, and an ending routes to the owning thread's log rather
than to whichever turn drains first.

**Steering is a mailbox, not an interrupt.** `agent_say` to a running child pushes onto that
child's queue and returns; the child's own `drainPending` splices the queue into `user-said` drafts
at the top of its next loop pass, which is already a tool-round boundary. To a *stopped* child it
appends `user-said` and starts a turn. The operator typing into an open child takes the identical
path, which is what makes "a child is just a thread" true rather than aspirational.

**Ordering at spawn is the invariant, and the transaction covers the child but not the parent.**
`createWithFirstEvents` writes the thread row and the brief together, so a child never exists
without its own first `user-said` — without it `awaitsReply` reads the child as nobody's turn and
its first `runTurn` returns `Idle` without a model call. The parent's `agent-spawned` is a separate
append, on purpose; why the transaction stops where it does is under attribution below.

**Recovery is lazy and read-triggered, not a boot pass.** `list()` hydrates a thread's roster from
its own log the first time anyone asks, because hydrating at construction would make a container
resolve block on the database. `agentRoster` rewrites exactly one status on the way through:
`Running` becomes `Stopped`, because `Running` is a claim about a process that no longer exists.
`Blocked` survives recovery unchanged, and the asymmetry is the point — the approval a blocked child
is waiting on is a row in the child's own log, and it is still there after a restart.

**There is no cap on how many children may be stepping at once.** A spawned child starts
immediately however many are already running, which is parity with background shells — Atlas caps
nothing else, and a queue is a second piece of state to reason about at exactly the moment the
operator wants to know why nothing is happening. The counter-argument was the measured one:
`bun:sqlite` appends are synchronous and block the render thread, so a wide enough fan-out can stall
the UI. That risk is accepted rather than denied, and the mitigation if it bites is the event-log
read path, not a pool.

### The five tools

`agent_spawn` starts one child or a whole wave and returns ids at once, never blocking; it declares
itself concurrency-safe, so a model that emits five spawn calls in one step genuinely fans out
through `Promise.all`. `agent_say` steers. `agent_resume` re-runs a child that died on a provider
error, appending nothing. `agent_list` reports the caller's own children. `agent_stop` aborts one,
which still delivers an ending. A child gets none of the five.

**`agent_stop` reports two different facts under two different names, and they must not be
unified.** A child still stepping returns `stopRequestedBy` — a request whose outcome is
undetermined, because the abort lands after the current step. A child already settled returns
`killedBy` — a recorded outcome. `attributedStop` is what gates the second on the child having
actually settled. They can legitimately **disagree**, and that disagreement is the feature: it is
how a model learns the operator stopped an agent before it got there. Collapsing them into one
field reads like a tidy-up and destroys the only signal that distinguishes "I asked" from "it
happened, and not because of me".

### Who stopped it, and how the parent finds out

**A model reading "was stopped" with no attribution assumes it stopped the child itself**, or that
something failed, and re-spawns it to finish the job — which is exactly the wrong response to a
human pressing stop. Shells solved this first and the vocabulary is shared rather than duplicated:
`EKilledBy` carries `User | Model | SessionEnd | Unrecorded`, and both `shellEnding` and
`agentEnding` phrase every case.

The chain runs end to end. `ctrl+k` while reading a child stops it as `EKilledBy.User`, `agent_stop`
passes `Model`, teardown stamps `SessionEnd` on anything still stepping. The supervisor records it
on the child, `agent-ended` carries it, and `attributedStop` drops it on any status but `Stopped`,
so a child that failed or finished is never described as stopped by anyone. `agentEndingsBlock`
then adds the sentence the status cannot carry: that the user stopped this one deliberately,
nothing went wrong, and not to re-spawn it unless asked.

**`Unrecorded` is the fourth member and it is named for what is provable.** Not `Crash`, not
`ProcessLoss` — Atlas does not observe a process dying, it observes that no ending was ever
written. It reads as *"was lost before anything recorded how it ended"*: never the word "stopped",
never an actor, because inventing either would be the same lie in the other direction. The status
stays `Stopped`, and the advice note tells the parent the work may be half-applied and to check
before redoing it. The name generalises to any reconstructed ending, not only a crash.

**Reconstruction is explicit, awaited, and separate from reading.** `ChildRecovery` splits the two:
read-only roster rebuilding stays lazy behind `hydrate`, while `recordLostAgents` — which *writes*
the missing `agent-ended` — is called once per conversation from `openConversation`, never from a
render or a `getSnapshot`. Nothing auto-resumes a recovered child. That is the operator's call,
because one that died mid-`bash` may have left the tree changed.

**A settled loss needs no second surface, and did not get one.** `settleLostChildren` writes a real
`agent-ended` carrying `Unrecorded`, `openConversation` does that *before* reading events, and the
transcript renders it like any other ending — so reopening a conversation already says a sub-agent
"was lost before anything recorded how it ended, after N turns and M tool calls". A notice would
have carried less than that row does and would not have persisted in scrollback.

**The unlogged case is different, and gets a veil panel on open.** A child thread that exists in
the store while the parent's log holds no `agent-spawned` cannot be rendered as a transcript row,
because the conversation holds no record to render. So `unloggedChildren` names and times them in
a report-only panel with no affordance — deliberately no affordance, since `agent_say` and
`agent_resume` would both answer `unknownAgent` for a child the parent never recorded.

**Healing one by forging the missing row was considered and rejected.** `@@unique([threadId, seq])`
means a reconstructed `agent-spawned` can only land at `head + 1`, and `rewindTarget` refuses on
`spawn.seq > toSeq` — so a spawn forged at the head would make the thread **permanently
un-rewindable**. Fabricating history to paper over a gap in history costs more than the gap. Store-only
orphans are therefore reported, never invented.

**The window that produces them is a live trade, not residue.**
`ThreadStorePort.createWithFirstEvents` makes the thread row and its opening events atomic, so a
child never exists without its brief — but the parent's `agent-spawned` is deliberately left
outside that transaction, and it stays outside. `retryOnWriteConflict` re-runs the closure on
`SQLITE_BUSY`, so a transaction widened across both threads would lose the race against the
parent's live turn: retrying forever against a `P2002` it cannot clear, or minting a fresh child on
every attempt. Widening it would convert a crash-sized window into a contention-sized one, which is
the worse of the two. This is a standing decision to re-argue on its merits, not a gap someone
forgot to close.

### Not built yet, and the shape each will take

**A child's approval has nowhere to go.** No hook returns `Ask` today, so nothing is broken in
practice, but the design is settled and worth recording where the approval effort will find it: a
child's request routes to the **parent agent**, as something the parent answers with a tool call,
and never to a human overlay. There is no human in a child's loop.

`EAgentStatus.Blocked` is the visible edge of that decision rather than a cosmetic status.
`ETurnStatus.Paused` used to map to `Stopped`, which told the parent "was stopped after N turns" —
the same sentence a deliberate stop produces, and the same wrong inference the attribution work
above exists to prevent. It maps to `Blocked` now, and `agentEnding` renders it as blocked on an
approval it cannot answer. The sidebar shows it as `blocked` with the amber attention glyph and
deliberately not with `APPROVAL_MARK`: `?` is the vocabulary for approvals the *operator* answers,
so spending it on a child would build exactly the second human-facing approval surface this
decision forbids.

What is still missing: the ending carries no `callId`, and `agent_resume` on a blocked child
re-enters the turn and pauses again immediately. Resuming must answer the approval rather than
retry it, which belongs with the approval effort.

**A message's origin is written but never read.** `user-said` carries an optional
`via: EMessageOrigin`, resolved through the single `saidBy` reader that defaults it to `Operator`,
and the spawn brief and every `agent_say` stamp `ParentAgent`. Nothing in production consults it
yet — it is groundwork for the sub-agent prompt and a transcript label, not a behaviour change.
Two members and not three: the brief is the parent's voice like any other steer, and its separate
role as the standing objective is an axis already carried by its position at the head of the log.

**Delegated spend is one conversation-level line, not a per-turn column.** A child's turns carry no
parent `runId`, so attaching their cost to whichever parent turn happened to be open would be an
invented attribution — and one that double-counts as soon as two children overlap. So
`forThreadTree` surfaces at the foot of the transcript, for the conversation as a whole.

**It is a tri-state rather than a number.** `ESpendReading` is `Counted` with totals or
`Unavailable`, and a failed read renders "could not be totalled" rather than zero, because zero is
a claim and it is the wrong one — it reads as "the sub-agents were free". `readThreadSpend` falls
back to `forThread` so the conversation still opens carrying its own turns, and raises a warn
notice naming the cause. `SupervisionTreeTooDeep` is unreachable while depth is capped at one; the
catch exists so that the day the cap moves, the failure is a missing cost line rather than a
conversation that will not open. The catch is insurance, not evidence that the throw is routine.

## Compaction

A long conversation walks into the context ceiling, so `assemble` re-deriving the whole prompt from the
log every step is not sustainable on its own. Compaction is what bounds it, and the shape it takes is
decided by one question: does it destroy the rows it compacts?

**One thread, one log.** The log *is* the thread, so every operation that adjusts context acts on the
current log rather than producing a second conversation. Rewind truncates it. Compaction replaces a range of it with a summary.
A sub-agent may one day inherit its parent's prefix **by reference**, which would be safe precisely
because that child is read-only over the inherited rows and its depth is bounded by agent nesting
rather than by how many times a human pressed undo. **Inheritance would be the spawning agent's
decision, not a property of sub-agents** — a sub-agent sent to read one file wants an empty log,
while one continuing the parent's line of work wants the context already in it, and only the caller
knows which. `EForkMode` is the vocabulary for it and the substrate is built.

**None of that is reachable today.** `EAgentStart` ships one member, `Fresh`, and every child starts
with an empty log holding only its brief. The reason is not caution about the invariants below —
it is that the spawn site cannot fork at all: a child forked from inside `agent_spawn`'s own tool
call is refused by `forkTarget`'s `UnsettledToolCall` guard, and bypassing that guard puts the
parent's dangling `tool_use` in the child's assembled prefix, where `exchangeFaults` fails the turn
before the model is called. Choosing a fork seq *before* the call does not help, because a parallel
batch leaves siblings unsettled at any seq. Reference forking is therefore its own effort, and it
needs an assembly answer first rather than a store one.

**Forking is the only operation that copies**, because it is the only one whose output is a second
conversation the user can reach and keep. Copying anywhere else buys storage nobody can navigate to:
thirty rewinds of a multi-megabyte thread is tens of megabytes of rows with no way to reference them.
So the operation is `ThreadStorePort.fork({ from, seq, mode, title })`, returning the new thread. It sits
on the thread store rather than the event log because it has to write the thread row and the event rows in
one transaction, which is the same reason `rewind` lives there. `EventLogPort.forkFrom` — which only ever
threw — is gone, and `readOwn` takes its place beside `read`: `read` returns the composed view a reference
fork implies, `readOwn` returns only the rows the thread itself holds.

**Six invariants stop holding the moment a child inherits rows it does not own**, because two things
that were true everywhere stop being true: `seq` no longer starts at 1, and `read({ threadId })` can
return events whose `threadId` is a different thread. An audit of every consumer found these. Five are
now closed — four of them by the fresh-only sub-agent work, which needed the same guarantees for a
different reason — and the list is kept because it is the acceptance criteria reference forking will
be held to:

1. **Closed. The loop reads `readOwn` for control flow.** `pendingCalls`, `outstandingApproval` and
   `awaitsReply` all read `rowsOwnedBy` rather than the composed list. Over a composed read they saw the
   *parent's* state, and a child forked from inside a tool call inherits an unsettled `tool-called` by
   construction: it would either pause forever awaiting a tool it never called, or re-dispatch the
   spawning tool and fork again. An inherited unanswered approval wedges a child the same way, because
   the answer can only be written on the parent above the fork point, where the child can never see it.
2. **Closed. A child is seeded with its own `user-said` in the same transaction that creates it.**
   `createWithFirstEvents` writes the thread row and the brief atomically, and only then does
   `openChildThread` append `agent-spawned` to the parent; without the brief, `awaitsReply` reads the
   child as nobody's turn and its first `runTurn` returns `Idle`. The parent's row is outside the
   transaction deliberately, which leaves one narrow window: a crash between the two makes a child the
   parent's log never mentions. That is reported, never fabricated — see the sub-agent section.
3. **Closed. `ERewindRefusal.UnendedSubAgent` refuses a rewind that would cut below a live child.**
   `unendedSpawns` finds any `agent-spawned` above the target with no `agent-ended` behind it, and the
   refusal names the child. An **ended** child does not block: its rows are a finished record, and
   refusing there would make every thread that ever delegated un-rewindable below its first delegation.
   The residue is the crash case named under sub-agents — an orphaned spawn is unended forever.
4. **Closed. Both self-relations are declared `onDelete: Restrict`.** `ThreadFork` on `parentThreadId`
   and `ThreadSupervision` on `spawnerThreadId`. There is still no thread-delete path; when one lands, a
   cascade would have stripped the parent's rows and left the child silently reading as though it never
   had a parent.
5. **Closed. The TUI's fake event log holds many threads.** It keeps rows and heads per thread, reserves
   sequences per thread, and implements `readOwn`, so a composition test can drive a parent and a child
   at once. It previously derived `seq` from array length and returned one thread's rows, which meant no
   composition test could express a sub-agent at all.
6. **Open, and moot until a child inherits.** An untitled child's sidebar title, turn count and live tool
   calls would all describe the parent, because `deriveSidebar` reads the composed list. A fresh child
   owns every row it holds, so there is nothing to confuse today.

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

The **launch directory** is fixed for the life of the process: it is what `--cwd` named, and it is
the only one held in the container, as `WorkspaceRoot`. The **project directory** is where the
session is working — the launch directory, or the worktree it has entered. It is the single anchor:
it anchors `.atlas/settings.json`, project skills, the instruction-file descent, every relative path
a tool is given, and the directory every bash command starts in.

There is deliberately no second, movable directory. A shell that can `cd` its way somewhere the file
tools do not follow gives the model two roots to keep straight, and the only way to make that
survivable is to keep telling it which is which. opencode and pi both refuse the split — one
anchor, and the shell is told where to run rather than allowed to wander. Atlas follows them.
Claude Code takes the other branch, letting one cwd move and paying for it in validation: seven
read-back rejections, forced approval for compound `cd`, per-subagent cwd pinning.

`bash` therefore takes a **`workdir`** parameter instead of tracking `cd`. It is a declared
`EPathForm.Absolute` path field, so `ResolveProjectPathsHook` resolves it against the project
directory like every other path, and a command runs where it is told without anything being
remembered afterwards. A `cd` inside a command still works, and still moves only the process that
ran it — which ends with the call.

The project directory is not held anywhere: it is
`projectDirectoryOf({ events, launchDirectory })`, the path of the last unclosed `worktree-entered`
in the log. That fold sits in the Conversation row so that rewind, fork and resume agree about it
without a second record to keep in step; a mutable holder in the container would have been the
checkpointer the two rules exist to refuse. `enter_worktree` moves it the only way anything moves
here — tool output an `AfterTool` hook turns into an event, never a setter.

Resolving tool paths against the project directory is also what makes rewind honest. A path resolved
against a cursor the conversation can move means a different file when the same log replays from a
different point, and the log is supposed to be the one record. `ResolveProjectPathsHook` makes every
declared `EPathForm.Absolute` field absolute at `EStage.Guard, nudge -1` — before anything downstream
keys on a path, so read-before-write cannot see the same file under two spellings.

Shells are spawned fresh per call, so nothing in the process survives it — an exported variable, a
shell function, a background job, a `cd`. Nothing is tracked out of band to make the directory an
exception.

**The prompt names one directory.** `cacheBreakpoints` puts a 1h breakpoint on the last system block,
and a directory that changed inside it would cold-start the whole prefix; with nothing moving between
calls there is nothing to invalidate it. Entering a worktree does cold-start that prefix, and is
allowed to: `systemPrompt` folds the log and hands the compiled prompt the effective project
directory, so the system block follows the move — one cache miss, paid once, for a deliberate act
that reshapes the whole session. `worktreeBlock` rides the message tail for what is genuinely live
about a worktree — the branch, and the checkout it was cut from.

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

**The curtain lifts onto a conversation that does not exist yet.** A launch with no `--resume` and
no `--continue` gets an `unstartedConversation`: a `ThreadId` handed out by `IdPort` and nothing
written. `openConversation` no longer calls `threads.create`, and neither does `/new`. The first
drafts open the thread and land in the same transaction, through
`ThreadStorePort.createWithFirstEvents` carrying the id already in play — the same primitive a
sub-agent's thread is opened with. So a session someone opened, looked at and closed leaves nothing
behind, and `/resume` lists conversations rather than the empty rooms of every launch since.

That makes the welcome screen a state rather than a block in an empty transcript. `ui/welcome-state.ts`
decides it from what is on screen — nothing said, nothing streaming, no failure, not addressing a
child — because a resumed thread rewound to zero is as unstarted to look at as one never written.
While it holds, the sidebar is not merely empty but absent, the transcript is not mounted, and the
wordmark and composer are centred with the whole terminal to themselves, picking up where the boot
curtain's own centred wordmark left off. The title of a conversation is asked for the moment the
first message is sent but written only once the thread that carries it exists, since that thread is
opened by the very turn the title was taken from.

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
  agents/        EAgentStatus, EAgentStart, the ending's prose, the roster fold
  prompt/        EPromptAgent — the main/sub axis the fragment registry selects on
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
  store/         Prisma event log, thread heads, workspace snapshots; migrations read from
                 prisma/ at dev time, generated manifest for --compile
  tools/         registry, dispatcher, builtin tools
  agents/types/     the agent-type definition, frontmatter parsing, built-ins, directory sources
  agents/registry/  AgentRegistryPort, the supervisor, the roster, notices, the child runner
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
| Sub-agents | A spawned thread, not a recursive call. Depth capped at one by the child's tool registry |
| DI | **tsyringe.** Class tokens, `@injectAll` for the hook and tool sets — see `.scratch/tsyringe-di/spec.md` |
| Hook discovery | Glob at dev time, generated manifest for `--compile` |
| Migrations | Read from `prisma/migrations` at dev time, generated manifest for `--compile`; an empty set is a startup failure |
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

Phases and phase briefs, reference-forked sub-agents, session rotation across accounts, MCP server lifecycle,
skills precedence against `CLAUDE.md`, container/sandbox isolation, PR shipping. Each is an assembly
rule, a hook, or a port implementation — none requires reopening a decision above.

Known gaps in the contract, accepted: a hook cannot fail the turn or annul a tool result, and hooks
see one call at a time rather than a batch.
