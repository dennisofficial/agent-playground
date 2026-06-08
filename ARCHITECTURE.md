# Agent Architecture — Working Design

> **Status: prototype / working draft.** These are good ideas, not approved decisions.
> Update this as the design evolves.

---

## Structure at a Glance

Each AI employee is **one self-contained process** with two layers and a connector:

- **Chat layer** — event-driven conversational identity. One LangGraph thread per Slack
  surface, scoped by `(channel, thread_ts)` — covers channels, DMs, and threads inside
  either. Decides respond/acknowledge/ignore via the gate. *Dispatches* jobs — does not run them.
- **Job runner** — always-on background process. Owns the agent's job registry. *Spawns*
  and owns the worker sub-agents. Posts results when they finish. This is what decouples
  chat from work: the chat turn can end while the worker keeps running.
- **Worker layer** — ReAct sub-agents, one per job thread (`job:{id}`). Tools always
  available; skills loaded on demand. Do the actual work.

**The job registry is the connective tissue.** All of an agent's chat threads share its one
registry, so any conversation can find any job and read its live state via a non-interrupting
`getState()`. → *Within an employee, every conversation can see every job.*

**Across employees:** sealed boxes. Alex cannot read Sam's worker threads directly — agents
coordinate through **Slack** (and optionally a shared DB), like real colleagues.

```
┌─ ALEX (one process) ───────────────────────────────────┐
│  CHAT LAYER                    JOB RUNNER (always-on)  │
│  ├─ dm:dennis    ─┐                                    │
│  ├─ dm:jake      ─┼─ dispatch ─►  Job Registry         │
│  └─ channel:dev  ─┘   (create job)   │ spawns          │
│        ▲ getState() (read-only)      ▼                 │
│        └──────────────────── WORKER LAYER (job:XYZ …)  │
└────────────────────────────────────────────────────────┘
        ▲ Slack is the only wire between employees ▲
```

---

## The Vision

A team of AI employees that behave like real colleagues at a company. Each one has a name,
a role, a memory of conversations, and ongoing work happening in the background. Multiple
humans in the company can talk to any AI employee at any time — and get a consistent,
aware response, just like messaging a real coworker.

When you ask "hey Alex, what's the backend looking like?", it should feel like texting a
developer who says "yeah I just got through the migration, hit a weird timeout, sorted it
out — want me to open the PR?"

---

## Guiding Principles

- **Each AI employee is its own entity.** Not a role, not a config — a distinct agent with
  its own memory, its own job runner, its own Slack presence.
- **Work is never blocked by conversation.** Chat and background work run independently.
  Asking "how's it going?" never pauses the task.
- **All humans in the company are the boss.** Any human can ask status, give direction, or
  approve actions. The agent tracks who asked for what.
- **Agents talk to each other through Slack.** No internal APIs between agents — they
  coordinate via shared channels, exactly like real colleagues.
- **Triggers are just inboxes.** Slack, email, CI/CD, GCP Pub/Sub — all normalize into the
  same event shape. The agent doesn't care where the signal came from.
- **Company knowledge is shared, conversation history is scoped.** Work history is
  company-wide (anyone can ask). DM conversations are private.

---

## Each Employee Is a Self-Contained Process

```
┌──────────────────────────────────────────────────────────┐
│                    ALEX (Backend Dev)                    │
│                                                          │
│  ┌─────────────────┐    ┌──────────────────────────────┐ │
│  │  Chat Handler   │    │        Job Runner            │ │
│  │                 │    │                              │ │
│  │  Event-driven   │    │  Always-running background   │ │
│  │  Wakes on:      │    │  Owns Alex's job registry    │ │
│  │  - Slack msg    │    │  Spawns ReAct sub-agents     │ │
│  │  - Email        │    │  Posts results when done     │ │
│  │  - CI/CD hook   │    │  Handles interrupt/approval  │ │
│  │  - GCP event    │    │                              │ │
│  │                 ├───►│                              │ │
│  └─────────────────┘    └──────────────────────────────┘ │
│                                                          │
│  ┌────────────────────────────────────────────────────┐  │
│  │                  Memory Layers                     │  │
│  │                                                    │  │
│  │  dm:{user_id}      — private conversation history  │  │
│  │  channel:{id}      — per-channel context           │  │
│  │  job:{id}          — ReAct sub-agent work history  │  │
│  │  company           — shared company knowledge (RAG)│  │
│  └────────────────────────────────────────────────────┘  │
└──────────────────────────────────────────────────────────┘
```

No global orchestrator. Alex manages his own jobs. Sam manages hers. They don't share
a job runner — they're colleagues, not threads in the same process.

---

## No Global Orchestrator

The "orchestrator" concept collapses into each agent's **Job Runner** — a lightweight
background process that's part of the agent, not shared infrastructure.

When you tell Alex "work on ticket XYZ":
1. Alex's chat handler creates a job entry: `{ task, requestedBy, notifyChannel }`
2. Dispatches it to Alex's own job runner
3. Job runner spawns a ReAct sub-agent for the task
4. When the sub-agent finishes, the job runner posts the result to `notifyChannel`

Alex's chat handler doesn't need to be awake for step 4. The notification target is
recorded at job creation — the job runner handles delivery.

---

## Sub-Agent Loop (ReAct)

Sub-agents are **rolling agentic workers** — reason → act → observe, looping until done.
This is the same pattern as Claude Code.

LangGraph ships a prebuilt: `createReactAgent`. The agent calls the LLM, the LLM decides
on a tool call, the result comes back as a message, the LLM sees it and decides the next
action. It loops until the LLM stops calling tools.

What makes agents *specialized* is their tool set + system prompt:

```typescript
const backendAgent  = createReactAgent({ llm, tools: [bash, readFile, writeFile, git, dbClient] });
const frontendAgent = createReactAgent({ llm, tools: [bash, readFile, writeFile, browserPreview] });
const qaAgent       = createReactAgent({ llm, tools: [bash, testRunner, screenshotTool] });
```

Same loop, same infrastructure — different capabilities and domain knowledge.

---

## Plan → Dispatch (collaborative planning, sub-agent execution)

**Flow:** human plans collaboratively *with the chat agent* → plan approved in chat → chat
dispatches the approved plan to a worker → worker executes. This is **plan-execute
separation** (cf. LangGraph plan-and-execute agents).

Better than inline plan-then-execute for an always-on employee: **the chat layer stays free
to talk while the worker grinds.** Planning is conversational, cheap, zero-risk; execution
is autonomous, long-running, high-risk — different modes, different agents.

**1. The plan is a structured artifact, not prose.** Ordered steps, each with: description,
acceptance criteria, files/areas touched, and an `approval_required` flag. This gives:
- Legible progress — "step 4 of 7" reads from plan + worker state (anchors `getState()`).
- Approval gates encoded in the plan — approve the plan once (cheap), and the plan marks
  which individual steps still pause for sign-off. Folds the `interrupt()` flow into the plan.

**2. Instruction vs. reference — what's resident vs. retrievable.** The worker *executes
against* the plan (instruction) and *consults* the planning history (reference). These get
two homes — the memory-paging spine, applied to the handoff:

| | What | Where |
|---|---|---|
| Resident | Structured plan + short **rationale digest** ("chose B over A because X") | Worker's active context — the unambiguous instruction |
| Retrievable | Full **marked** planning section | Paged in on demand — the "why," via `read_planning_history(job_id)` |

- **Mark the planning section** in the chat history (cf. harness `mark_chapter`). This scopes
  the fork to *just* that segment and gives humans a legible boundary.
- **The fork is logical, not a copy.** The marked section already lives in the chat thread's
  checkpoint — give the worker a tool to read that range on demand (LangGraph checkpoint
  forking / time-travel). Only the distilled plan is actually transferred resident.
- **Do NOT put the raw transcript resident.** Two failure modes: (a) token bloat paid on
  every ReAct step (the worker re-reads it each loop); (b) *rejected-approach contamination* —
  if approach A was discussed then rejected, raw history sitting resident lets the worker
  drift toward A. Distillation's job is to make the *decision* unambiguous; the plan states
  *what*, the history explains *why*.

**3. "Plan mode" is enforced structurally — for free.** The chat agent doesn't hold mutation
tools at all (they live in the worker), so it is *permanently* in plan mode by construction.
The boundary between planning and doing is the boundary between two agents with different
tools. Approval is the gate the plan crosses from the toolless planner to the tooled executor.

**4. Design for drift (the part that bites).** Execution diverges from plans. Use **bounded
autonomy**: the worker adapts *tactics* (the *how* of a step) on its own, but must return to
re-plan on *strategy/scope* changes (the *what*) and always for anything crossing an approval
line. Mechanically: worker detects off-plan → `interrupt()` → posts proposed amendment to
Slack → human/chat approves revised plan → resume. The plan is a contract; contracts get
amended, never silently.

---

## Reference Patterns (borrowed from the Claude Code harness)

The Claude Code agent is a working implementation of much of this design. Patterns worth
copying, mapped to our components:

| Harness mechanism | Pattern | Our equivalent |
|---|---|---|
| `ToolSearch` (deferred tools) | Catalog + load-on-demand | Skills loader — **apply to tools too** |
| Subagent returns *final message only* | Workers return conclusions, not transcripts | chat↔worker boundary |
| `advisor()` — reviewer sees full transcript | Independent review at decision points | CTO / code-review / adversarial verify |
| Plan mode | Approval as an enforced *mode*, not a check | `interrupt()` / prod-approval flow |
| Background task + re-invoke on completion | Don't poll — get woken when done | job runner posting results |
| `isolation: worktree` | Parallel mutators need isolation | parallel engineering workers editing files |
| `Workflow` pipeline / parallel | Deterministic fan-out beats model looping | sub-fan-out inside a worker |

**The four to internalize deepest:**

1. **Progressive disclosure runs all the way down.** The harness doesn't hold tool *schemas*
   in context — deferred tools are names until fetched on demand. Same primitive as our
   skills loader. A worker with 40 tools should get a tool *catalog* + load-on-demand, not
   40 resident schemas. One implementation serves both skills and tools.

2. **Two channels for worker visibility.** A subagent's live history lives in its own thread
   (read via `getState()` for "how's it going"); what it *returns* on completion is a
   distilled conclusion ("what's the result"). Don't conflate the firehose with the summary.

3. **Reviewer-with-full-context at decision boundaries.** A stronger model receives the
   *entire* transcript before committing to an approach, when stuck, and before declaring
   done. The value is in *when* it fires, not just that it exists. Bake these trigger points
   into workers.

4. **Approval enforced at the harness layer.** Plan mode *disables* mutation tools until
   approved — not a politeness the prompt hopes the model honors. Prod-touch approval should
   likewise make dangerous tools un-callable until `updateState({approved:true})`.

**Do NOT copy:** the harness's tool *breadth* (workers stay focused — see granularity);
interactive primitives literally (async Slack equivalent = post question + `interrupt()` +
resume on reply); `ToolSearch` for tiny tool sets (progressive disclosure only pays at scale).

---

## Agent Granularity — Split by Domain, Not Sub-Role

**Principle: separate agents at domain boundaries, unify sub-roles via skills.**

The specificity that improves quality comes from several sources. Skills (progressive
disclosure) fix the biggest one — focused active context per task. But skills do NOT fix:
- **Persona / taste** — lives in the base system prompt, not a loaded skill. You can't bake
  strong opinionated judgment in 7 domains into one prompt without it turning to mush.
- **Best model per domain** — one agent runs one model per loop; only separate agents can
  use the empirically-best model per domain (the whole point of the multi-LLM benchmarking).
- **Skill-selection accuracy** — a huge catalog routes worse than a focused one.
- **Independent eval & tuning** — a generalist's quality is entangled across domains.

**Where to draw the line:**
- **Split across domains** (Engineering / Marketing / Product) — genuinely different taste,
  tools, models, success criteria. Specialization earns its keep here.
- **Do NOT split within a domain** (backend / frontend / QA / infra as separate agents) —
  that's sub-role splitting. It causes *handoff thrash*: "add user avatars" touches backend
  storage + frontend UI + CDN config. Three agents = three handoffs for one small feature;
  one Engineering agent with three skills = one coherent unit of work.

**Why this is the right altitude:** Claude Code is a generalist that works — because backend,
frontend, infra, and review are all *one domain (software)* with one coherent persona. The
trouble starts only when an agent spans *domains* (marketing + code + SEO). So the seam is
between domains, not within them.

**Target: ~3 domain agents**, not 1 mega-generalist (mediocre at everything) and not 7
hyper-narrow ones (handoff thrash, premature org chart). Each domain agent is a focused
persona + its own model + a skill library covering the sub-roles inside its domain.

**Start: one-domain-first.** Build the Engineering agent, prove the full loop, add Marketing
as a second domain later. The env-config design (same codebase, per-agent config) makes
adding a domain cheap — so this is deferral, not lock-in.

> The earlier "roster" (Backend Dev / Frontend Dev / QA / CTO / Marketing) illustrates
> *capability coverage*, not the agent count. Per this principle, backend/frontend/QA
> collapse into one **Engineering** agent with skills; the real agent boundaries are the
> ~3 domains.

---

## Skills — Procedural Memory for Sub-Agents

Skills are the third memory type, completing the taxonomy:

| Memory type    | Answers             | In our system        |
|----------------|---------------------|----------------------|
| Semantic       | What's *true*?      | mem0 facts           |
| Episodic       | What *happened*?    | conversation archive |
| **Procedural** | *How* do I do this? | **skills**           |

Skills live with the **workers** (sub-agents), not the chat layer. A skill is a folder:
`SKILL.md` (name, description, step-by-step procedure) + optional `scripts/` (executed)
and `references/` (read only if needed).

**Skills ≠ tools.** Tools are atomic capabilities (`bash`, `read_file`) — always available.
Skills are procedural playbooks that *orchestrate* tools ("to deploy: run tests, check the
runbook, run `scripts/deploy.sh`"). Sub-agents have tools always; load skills on demand.

**Progressive disclosure (the "load it" mechanic) — 3 levels:**
```
Level 1  Catalog       always in system prompt, tiny — name + 1-line description each
Level 2  load_skill()  task matches → full SKILL.md enters context on demand
Level 3  Resources     SKILL.md points to scripts (run, not read) and docs (read if needed)
```
The point is token efficiency: a worker loads the ONE relevant skill, not all of them.
The catalog stays small enough to always sit in context. Same pattern as Claude Code skills.

**Shared library = encoded company process.** One skill library, used by all workers, so
every agent does migrations / PRs / bug-triage the same way. This is the procedural
counterpart to company memory:
- Company facts (what): "refund policy is 7 days"
- Company skills (how): "here's how we ship a refund-policy change"

Optionally scope which skills each role *sees* (frontend agent doesn't need the DB-migration
skill in its catalog), but the library itself is shared infrastructure.

**Selection: LLM-driven.** The spawned sub-agent reads the catalog and picks which skill(s)
to load for the task (a job may also preload one for determinism).

**Portability:** the progressive-disclosure pattern (catalog + `load_skill` tool + skill
folders) is provider-agnostic. Anthropic's native Agent Skills are an option if workers
standardize on Claude; the homegrown loader keeps it portable across the multi-LLM stack.

---

## How Chat Gets Visibility Into Sub-Agent Work

**The message history is the log.** Every reasoning step, tool call, and tool result is
appended to `state.messages` automatically. No separate logging table needed.

The chat handler reads it with a non-interrupting `getState()` call:

```typescript
const state = await subAgentGraph.getState({
  configurable: { thread_id: 'job:123' }
});
// state.values.messages = full ReAct history: reasoning, tool calls, results
```

The chat LLM takes that raw history and narrates it conversationally:

```
Raw:    [ToolCall: bash("pnpm test"), ToolMessage: "2 failing", AIMessage: "Looking at expectations..."]
Spoken: "Tests are still red after my first fix — I'm digging into why now."
```

---

## Memory Layers

**Mental model: memory paging.** Big context windows just make "RAM" bigger — they don't
remove the need for "disk." The agent runs on a small rolling window and pages in from
durable stores via tools, only when needed.

| Tier                                 | Role                                       | Analogy             |
|--------------------------------------|--------------------------------------------|---------------------|
| Working memory (checkpoint, trimmed) | Last N messages fed to the LLM each turn   | RAM                 |
| Episodic / conversation archive      | Full searchable history of what was *said* | Disk                |
| Semantic facts (mem0)                | Distilled "what's *true*"                  | Index / cheat sheet |
| Company knowledge (RAG)              | Docs, runbooks, codebase                   | Reference library   |

**Retrieval is hybrid** (the key finding from memory-layer research): combine semantic
search (vector similarity — "find that auth discussion" without the word "auth") with
precise fetch (`conversations.replies` — "pull the exact thread from Tuesday"). Give the
agent both as tools. Keep retrieval bounded (top-k under a token budget), not dump-everything.

Four tiers, each serving a different purpose:

### 1. Working memory — LangGraph Checkpointer
The active `messages` array for a conversation or job. Already wired up.
Swap `MemorySaver` → `SqliteSaver` for persistence across restarts.

**Scoping mirrors Slack's `(channel, thread_ts)` coordinate.** Slack hands us a uniform
identifier for *every* conversation surface — and that includes **threads inside channels
AND threads inside DMs** (yes, you can thread under a DM). A DM is not "one conversation";
it's a container with a root timeline plus any number of threads. So scope by:

```
thread_id = {agent}:{channel}:{thread_ts ?? 'root'}
```

- `zero:C0ENG:root`     — #engineering main timeline
- `zero:C0ENG:1718-99`  — a specific thread in #engineering
- `zero:D0DENNIS:root`  — the DM's main line
- `zero:D0DENNIS:1718-42` — a thread *inside* that DM

The channel id prefix already encodes the container type (`C`=channel, `D`=DM,
`G`/`mpdm`=group DM), so the old hand-rolled `dm:` vs `channel:` split is replaced by this
one scheme — which also (unlike the old one) gives each thread its own focused checkpoint so
parallel sub-conversations don't bleed together. Slack threads are exactly one level deep
(no sub-threads), so the tree is: container → root → threads.

Implications: (a) the response gate threshold **drops inside a thread the agent is already
in** — follow-ups don't need a re-@mention, like a human already in the conversation;
(b) a job dispatched from a thread stores `(channel, thread_ts)` as its reply target so the
result posts **back into that thread**, not the channel root; (c) reply in the surface you
were addressed in — escalating a thread reply to the whole channel is a deliberate act.

**When the window fills up — anchored window + running summary.**
Compaction is NOT a second storage step. Every message is already embedded into the
episodic store at ingestion, so nothing is lost by compacting. Compaction only keeps the
*live* window coherent under the token budget.

```
[ system prompt ]         ← never evicted
[ running summary ]       ← evolving gist of everything older
[ last K turns verbatim ] ← recency, kept exact
```

At ~70% of the token budget: fold the oldest messages into the running summary
(`new_summary = LLM(old_summary + evicted)`), drop the raw messages from the window. If a
specific evicted detail is needed later, the agent pages it back via `search_conversations()`.

**Gotchas:**
- Trigger on **tokens, not message count** (`trimMessages` from `@langchain/core/messages`
  is token-aware).
- **Never orphan tool calls** — a `ToolMessage` and the `AIMessage` that called it must
  stay paired, or the API rejects the request. Compact only at clean turn boundaries.
- Run the summary on a **cheap model** (Haiku / gpt-4o-mini) — see Multi-LLM. It fires
  only at threshold, so cost is low.
- Optionally persist each summary to the episodic store as a retrievable "chapter."

**Division of labor:** continuity = running summary; recency = last K verbatim;
detail = episodic store (already indexed, paged in on demand). Together the conversation
runs effectively forever under a fixed token budget.

Native option (deferred): some providers ship context-editing / memory tools that
auto-compact old tool results. Provider-specific — keep the portable approach above as the
default given the multi-LLM direction.

### 2. Episodic memory — Conversation archive (the "disk")
A vector index of raw message chunks — the full searchable history of what was *said*
(as opposed to mem0's distilled facts about what's *true*).

**Why we build this and don't lean on Slack search:** Slack *bot* tokens cannot do
full-text search — `search.messages` requires a *user* token (`search:read`). Bots can
only read `conversations.history` of channels they're in. So workspace-wide search isn't
free from Slack.

**But ingestion is free** — the response gate already receives every message via the
Events API. The same event feeds the episodic store:

```
Slack message arrives (Events API)
        │
        ├──► Response gate     (respond? acknowledge? ignore?)
        ├──► Memory gate       (mem0: extract a fact?)
        └──► Episodic store    (embed + index the raw message)  ← conversation search
```

One ingest, three consumers. Conversation search is then a tool:
`search_conversations(query, channel?)` → semantic similarity → relevant past exchanges.

### 3 + 4. Semantic memory + Company knowledge — Vector store (unified)

**KV storage is wrong for facts.** The naming consistency problem: "company:policy:refund"
and "company:policies:money_back" are different keys but the same concept. A KV store
has no way to reconcile them — lookups fail silently, facts duplicate under different names.

**Facts need retrieval by meaning, not by exact key.** Both semantic memory (learned
facts) and company knowledge (documents, runbooks) are retrieved by semantic similarity.
They're the same infrastructure at different scales — same vector store, different
collections:

```
Vector store
├── collection: "facts"      ← short learned facts, agent-extracted
│   metadata: { scope, source, date, confidence }
│   scopes: "company" (shared) | "alex" (private to Alex)
│
└── collection: "documents"  ← codebase, runbooks, architecture docs
    metadata: { type, path, last_updated }
```

Retrieval is by semantic query — "what's our return window?" finds the refund policy
fact even though the strings don't match. No canonical naming convention to enforce.

**Self-managed memory tools (vector-based):**

```typescript
remember({ fact: "Refund policy is 7 days", scope: "company" })
// embed → check for similar existing facts → upsert if found, insert if new

recall({ query: "what's our refund policy?", scope: "company" })
// embed query → similarity search → return top matches

update({ query: "refund policy", newFact: "Refund policy is now 14 days" })
// find existing fact by similarity → overwrite

forget({ query: "refund policy", scope: "company" })
// find by similarity → delete
```

**Company facts and the race condition:** when a fact arrives in #general, all agents
embed and store it to `scope: "company"`. Simultaneous writes of the same fact are fine —
the deduplication check finds the existing embedding and upserts rather than duplicates.

**Decision: use mem0 (open-source, self-hosted).** Apache 2.0 core, free to self-host.
Gives us fact distillation, update/delete, and multi-agent scoping out of the box instead
of reimplementing them. Vector-based, no graph DB required. Its "current truth" model is
the right fit for a company assistant (95% of queries are "what's true now").

**The abstraction boundary is the tool interface, not mem0 itself.** Agents only ever call
`remember()` / `recall()` / `update()` / `forget()`. mem0 sits behind those tools. This
keeps the backend swappable — see upgrade path below.

**Scoping:** mem0 supports multi-scope memory natively. Map our scopes onto its
user/agent/run identifiers:
- `company:*` → a shared scope all agents read/write
- `{agent}:*` → per-agent private scope
- `{agent}:user:{id}` → per-agent, per-human scope

**Embeddings provider — decided: OpenAI `text-embedding-3-small` (1536 dims).** Used for
both mem0 facts and the episodic conversation index. Anthropic has no embeddings API; this
dimension is baked into the schema, so it's fixed now. The LLM mem0 uses for fact
extraction is independent of the embedder and can be any model (see multi-LLM below).

**Note (ADD-only):** mem0's current architecture favors ADD-only fact extraction with
entity linking — it appends and links rather than destructively overwriting, so it
preserves change-over-time better than a naive overwrite model. This further reduces the
need for Graphiti in the near term.

**Upgrade path — Graphiti (temporal knowledge graph).** If "what was true at time X"
becomes a real product requirement (e.g. honor the refund policy active when a customer
signed up), Graphiti (OSS, MIT) models facts as edges with validity windows — native
bi-temporal. Cost: requires Neo4j/FalkorDB. Defer until temporal audit is load-bearing;
swap behind the same tool interface when needed.

---

### The memory pipeline

```
Conversation / event happens
       │
       ▼
Working memory (checkpointer — active messages, trimmed)
       │
       ├──► remember() tool called by agent
       │         │
       │         ▼
       │    Vector store: facts collection
       │    (embed + upsert, scoped to agent or company)
       │
       │  periodic summarization of old working memory
       ▼
Episodic memory (vector store: interactions collection)
       │  agents query this for "what happened last week?"

At response time:
  recall() → similarity search → top facts injected into system prompt
  RAG      → similarity search → relevant docs injected into system prompt
```

### Self-managed memory tools

Rather than hardcoding what gets saved, give the agent tools to curate its own memory.
The agent decides mid-conversation what's worth keeping:

```typescript
remember({ fact: "Dennis prefers TypeScript over JavaScript" })
update({ id: "...", fact: "Dennis is now the CTO, not team lead" })
forget({ id: "..." })
```

These write directly to the LangGraph Store. The agent acts as its own memory editor —
it learns rather than just accumulates logs.

---

## Shared Channels — The Response Gate

All bots are members of shared channels (#dev-chat, #general, etc.). Every bot receives
every message. The gate decides what each agent does with it.

**Three tiers — not just respond/ignore:**

| Decision      | Action                                     |
|---------------|--------------------------------------------|
| `respond`     | Post a full reply                          |
| `acknowledge` | React with ✅ or 👍- "got it" without noise |
| `ignore`      | Nothing visible                            |

**Critical: memory updates regardless of response decision.**
Even when ignoring, the agent processes the message for its memory store. "Refund policy
is now 7 days" → all agents update their semantic memory, even if only one posts anything.
The gate controls output, not learning.

```
Message received
      │
      ├──► Memory gate: is this worth remembering? → update Store
      │
      └──► Response gate: what do I do visibly?
                │
                ├── respond      → full agent reply
                ├── acknowledge  → emoji reaction only
                └── ignore       → nothing
```

**Gate logic — fast rules first, LLM only for ambiguous cases:**

```
@ThisAgent mentioned (by anyone, human or bot) → respond       (hard rule)
Message from myself                            → ignore        (hard rule, always)
Last N messages in thread are all bots,
  no human has spoken                          → pause, ask a human
@AnotherAgent mentioned, not me               → ignore        (they'll handle it)
Message from a bot, not addressing me          → LLM gate (not auto-ignore)
Question in my domain                         → LLM decides
Company-wide announcement                     → LLM decides (likely acknowledge)
Casual conversation I'm not part of           → ignore
```

The LLM gate prompt: *"You are Alex, backend dev. A message was just posted in #dev-chat.
Should you respond, react silently, or stay quiet? Consider: are you addressed? Is this
your domain? Does a response add value or just noise?"*

**Agents collaborate through @mentions — same as humans:**
Alex finishes backend work → posts "@Sam, just pushed the auth endpoints. POST /auth/login
takes {email, password}, returns {token, expiresAt}. Ready for you." → Sam's gate sees
the @mention, responds, asks clarifying questions, picks up the work. Humans can read the
whole thread and jump in at any point.

When blocked or uncertain, agents ask rather than guess — same pattern as Claude Code
asking clarifying questions. Agent hits ambiguity → @mentions the relevant human or posts
in the channel → interrupt() → waits for reply → resumes.

**Context shifts the threshold:**

| Context                     | Default posture                         |
|-----------------------------|-----------------------------------------|
| DM with any human           | Always respond                          |
| Thread this agent started   | Respond to replies                      |
| Thread someone else started | Only if addressed                       |
| Shared channel (#dev-chat)  | Gate applies                            |
| #general / #announcements   | Stricter — mostly acknowledge or ignore |

**Company-wide announcements:** decide early whether one agent acknowledges on behalf
of all (e.g. the CTO bot), or all silently learn with no visible response. Avoid five
bots each saying "Got it!" — that's noise, not teamwork.

---

## How Agents Talk to Each Other

Through Slack — exactly like real colleagues. No internal APIs between agents.

When Alex finishes a task and QA should pick it up, Alex posts in #dev-channel:
"Finished the auth refactor, ready for QA review." Jordan's chat handler sees the event,
the gate recognizes it as a relevant handoff, and Jordan creates a job in her own job runner.

Agents are loosely coupled — the shared Slack channels are the coordination layer, and
humans can see and participate in all of it.

---

## Each Agent Is a Slack App — All in One Process

Each AI employee is a real Slack workspace app — their own bot token, their own profile,
their own AI-generated photo. From inside Slack it's indistinguishable from a human team
member scrolling through #dev-chat history.

**All agents run in a single Node.js process on a single port.** One Express server hosts
multiple Slack Bolt instances, each mounted at a different path:

```
Alex   → https://your-server.com/slack/alex
Sam    → https://your-server.com/slack/sam
Jordan → https://your-server.com/slack/jordan
```

Each Slack app's webhook URL points to its agent's path. Bolt uses the per-app signing
secret to verify requests. From Slack's perspective they're separate apps. From the server's
perspective it's one process.

```typescript
const AGENTS = [
  { name: 'alex',   role: 'backend_dev',  token: '...', signingSecret: '...' },
  { name: 'sam',    role: 'frontend_dev', token: '...', signingSecret: '...' },
];

for (const config of AGENTS) {
  const receiver = new ExpressReceiver({
    signingSecret: config.signingSecret,
    app: expressApp,
    endpoints: `/slack/${config.name}`,
  });
  const boltApp = new App({ token: config.token, receiver });
  const agent = buildAgent(config); // LangGraph graph + job runner for this agent
  boltApp.message(async ({ message, say }) => agent.handleMessage(message, say));
}

expressApp.listen(3000);
```

**Adding a new employee:** create a Slack app, add one entry to `AGENTS`, deploy.
No new servers. No new processes.

**Concurrency is fine.** All agent activity is I/O-bound (LLM API calls, tool executions).
While Alex's ReAct loop awaits an Anthropic response, Sam's handler can process a new
message. Node's async model handles this naturally.

**Shared infrastructure (minimal):**
- Company vector store — all agents read it, no one owns it
- Slack — coordination layer for inter-agent communication
- Optionally a shared DB for cross-agent job visibility (TBD)

Everything else (memory, job runner, LangGraph graphs) is per-agent and isolated.

---

## Multi-LLM by Design

This is a multi-model system on purpose — different models have different strengths, and
we benchmark to find the best fit per role. **Model choice is per-role config**, sitting
alongside the system prompt and tool set:

```
Alex (backend):  worker=claude-sonnet  gate=haiku(cheap)  extraction=gpt-4o-mini
Sam (frontend):  worker=gpt-4o         gate=haiku         extraction=gpt-4o-mini
Embeddings (shared): text-embedding-3-small
```

Roles that can each use a different model:
- **Worker** — the ReAct sub-agent doing real work (needs strong reasoning)
- **Gate** — the respond/acknowledge/ignore decision (cheap + fast; runs on every message)
- **Extraction** — mem0's fact distillation (cheap is fine)
- **Chat** — the conversational front (balanced)

LangChain makes this clean: every model is a `BaseChatModel`, injectable anywhere. The
gate's cost matters most — it fires on *every* message in every channel, so a cheap fast
model there directly controls the floor on token burn.

**Implication for `chat.ts`:** the current `build()` has Anthropic-specific logic (the
opus sampling-rejection check). Going multi-provider means a small provider-abstraction
factory: `modelFor(role)` returns the right `ChatAnthropic` / `ChatOpenAI` / etc. instance.
Not needed yet — flagged as the natural next refactor when a second provider lands.

---

## Trigger Normalization

Every external trigger becomes an `Event` before the agent touches it:

```typescript
type Event = {
  type: 'slack_message' | 'email' | 'cicd' | 'gcp_pubsub' | 'scheduled';
  source: string;        // channel ID, sender email, pipeline name, etc.
  from?: string;         // human identifier, if applicable
  payload: unknown;
  receivedAt: string;
};
```

The chat handler classifies the event: needs a response? needs a job? both?

---

## Approval Flow

When a sub-agent needs to touch real data or make a risky change:

1. Sub-agent hits `interrupt()` in its LangGraph node — graph pauses, checkpoint saved
2. Job runner sees the pause → posts to Slack: "I need sign-off to run this migration"
3. Any authorized human replies with approval
4. Chat handler routes that reply → `graph.updateState({ approved: true })` → sub-agent
   resumes from exactly where it stopped — no restart, no lost context

---

## The AI Employee Roster (Planned)

| Agent | Domain | Special tools |
|---|---|---|
| Backend Dev | APIs, DBs, migrations | bash, git, DB client, file r/w |
| Frontend Dev | UI, components, CSS | bash, git, file r/w, browser preview |
| QA | Testing, edge cases | bash, test runner, screenshot tool |
| CTO | Architecture, review | reads other agents' work history |
| Marketing | Copy, campaigns | CMS, analytics, email tools |

Each is a separate entity with its own Slack bot, own memory, own job runner.

---

## Operational Gotchas (will bite you in this order)

**Loop prevention.** Bots replying to bots replying to bots. Two rules: (1) never respond
to a message from another bot unless explicitly addressed, (2) never respond to your own
messages. Add a `shouldRespond()` gate before the agent processes any event. Check the
message author's `bot_id` field.

**Slack rate limits.** Slack's API has per-method and per-workspace limits. A ReAct agent
making tool calls in a loop across multiple agents simultaneously will hit them. Buffer
outgoing messages, back off on 429s, and don't fire-and-forget Slack API calls.

**Cost/token burn.** An agent that can wake itself up (via scheduler or trigger) can
accumulate LLM calls silently. Add a daily token budget per agent and a circuit breaker
that pauses autonomous work when the budget is hit. Log every LLM call with its token
count somewhere visible.

**Permissions.** Decide early: what can the agent *do* vs *suggest*? The interrupt/approval
flow handles the "needs sign-off" case, but you need an explicit list of what requires
approval vs. what the agent can do autonomously. Err toward requiring approval and loosen
over time — it's easier to grant permissions than to recover from an agent that deleted
something it shouldn't have.

---

## Open Questions / TBD

- [ ] How does a sub-agent signal "I need help from another agent" (not just approval)?
- [ ] How do agents maintain awareness of each other's work? (read shared channels? query each other?)
- [ ] Proactive outreach: how does an agent ping you when it finishes without being asked?
- [ ] Multiple instances: if two humans DM Alex at the same time, is that one process or two?
- [ ] Episodic summarization cadence: when/how often does episodic → semantic distillation run?
- [ ] What's the permissions model for memory tools — can an agent forget things a human told it?

---

## Prototype Build Order

1. ✅ Chat agent with MessagesAnnotation + MemorySaver (done)
2. Job registry (SQLite — per agent, simple status/routing table)
3. First ReAct sub-agent (`createReactAgent` + a few tools like bash + file read)
4. Chat handler tool: `get_job_status(jobId)` — reads sub-agent `getState()`, summarizes
5. Job runner (background loop that spawns sub-agents and posts results on completion)
6. Approval interrupt loop
7. Trigger normalization + Slack event router
8. Second agent (proves multi-employee model)
