# Memory Implementation Plan for Zero

> **Status: actionable plan / awaiting a few human decisions.** Derived from a full read of the
> current codebase (`src/`, `ARCHITECTURE.md`, `package.json`, configs) on 2026-06-08.
> The companion design doc is `ARCHITECTURE.md` (§ "Memory Layers"); this file turns that vision
> into concrete file-by-file work for the code as it actually stands today.

---

## 0. Where the code is right now (ground truth)

The repo is a single-process Ink CLI ("DennisGPT") wrapping LangChain/LangGraph. The relevant
moving parts for memory:

| Concern        | File               | Current state                                                                                                                                                                                                                                                       |
|----------------|--------------------|---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------|
| Chat agent     | `src/chat.ts`      | `createAgent({ model, tools, systemPrompt, checkpointer: new MemorySaver() })`, lazily built + memoized in `getGraph()`                                                                                                                                             |
| Turn loop      | `src/conductor.ts` | Single serialized runtime. `getGraph().stream(..., { configurable: { thread_id }, streamMode: 'messages' })`. `commit()` finalizes each message into history. **This is the one place every user + assistant message passes through** — the natural ingestion hook. |
| Threading      | `src/jobs.ts`      | `CLI_THREAD_ID = 'zero:cli:main'` is the only chat thread today. Jobs carry `notifyThread`.                                                                                                                                                                         |
| Model          | `src/model.ts`     | `buildModel()` → `ChatAnthropic('claude-sonnet-4-6')`. No embeddings model anywhere yet.                                                                                                                                                                            |
| Persona        | `src/persona.ts`   | `ZERO_CHAT_PROMPT` (static string), `workerPromptFor(engine)`. Static system prompts — no injected memory context.                                                                                                                                                  |
| Tools          | `src/tools.ts`     | `read_file`, `list_dir`, `grep` (chat); `write_file`, `str_replace`, `glob`, `web_fetch`, `bash` (worker). All jailed to `ROOT` via `src/engines/guard.ts`.                                                                                                         |
| Worker engines | `src/engines/*.ts` | `langgraph` (shares our LangChain tools + `MemorySaver`), `claude` (Claude Agent SDK subprocess), `codex` (Codex SDK subprocess).                                                                                                                                   |
| UI             | `src/ui/*`         | Renders from conductor state; not involved in memory.                                                                                                                                                                                                               |

**Key facts that shape the plan:**

- **Everything is RAM-only.** Chat checkpoints (`MemorySaver`), the langgraph worker
  (`MemorySaver` in `engines/langgraph.ts`), and the job registry (`Map` in `jobs.ts`) all vanish
  on restart. `ARCHITECTURE.md` already flags the SQLite swaps.
- **No persistence layer exists at all** — no DB, no data dir, no native deps. We are adding the
  first one.
- **`@langchain/openai@^1.4.7` is already a dependency** but unused. ARCHITECTURE decided on OpenAI
  `text-embedding-3-small` (1536 dims) for embeddings — but **there is no `OPENAI_API_KEY` wired**
  (`.env.example` / `.env.personal` only have `ANTHROPIC_API_KEY`).
- **`@langchain/langgraph-checkpoint@1.0.4` is already installed** (transitive). The SQLite saver
  (`@langchain/langgraph-checkpoint-sqlite`) is **not**.
- **The conductor's `commit()` is the single choke point** for finished messages — ideal for
  episodic ingestion without touching the UI or the graph internals.
- **Only the `langgraph` worker engine shares our tool objects.** The `claude` and `codex` engines
  run in subprocesses with their own built-in tools, so memory tools given as LangChain `tool()`
  objects reach the chat agent and the langgraph worker only. (Memory for Claude/Codex workers would
  need MCP — out of scope; see Design Decision D9.)

---

## 1. Shared foundation (built once, used by all three tiers)

Before the tiers, three small shared modules. New directory: **`src/memory/`**.

### 1.1 `src/memory/paths.ts` — data directory

```ts
// Resolves a gitignored data dir under the project root, creates it on first use.
// e.g. ROOT/.data  →  holds zero.db (SQLite) and any index files.
export const DATA_DIR = resolve(ROOT, '.data');
export function dataFile(name: string): string { /* ensure DATA_DIR exists, return join */ }
```

- Add `.data/` to `.gitignore`.
- `ROOT` comes from `src/engines/guard.ts` (already the canonical project root).

### 1.2 `src/memory/db.ts` — one SQLite handle

A single `better-sqlite3` database (`./.data/zero.db`) shared by episodic + semantic tiers, with
the `sqlite-vec` extension loaded for vector search. Working-memory checkpoints get their **own**
file (`./.data/checkpoints.db`) owned by `SqliteSaver` — keep them separate so a schema change in
one tier can't corrupt the other.

```ts
import Database from 'better-sqlite3';
import * as sqliteVec from 'sqlite-vec';
let db: Database.Database | undefined;
export function getDb() {
  if (!db) {
    db = new Database(dataFile('zero.db'));
    db.pragma('journal_mode = WAL');
    sqliteVec.load(db);              // registers vec0 virtual tables
    runMigrations(db);               // CREATE TABLE IF NOT EXISTS … (episodic, facts, documents)
  }
  return db;
}
```

### 1.3 `src/memory/embeddings.ts` — the embedder

```ts
import { OpenAIEmbeddings } from '@langchain/openai';
// text-embedding-3-small, 1536 dims — the dimension is baked into the vec0 schema, so it is fixed.
let embedder: OpenAIEmbeddings | undefined;
export function getEmbedder() {
  return (embedder ??= new OpenAIEmbeddings({ model: 'text-embedding-3-small' }));
}
export const EMBED_DIM = 1536;
```

- Lazily built (same pattern as `buildModel()`), because the constructor throws without
  `OPENAI_API_KEY`. **Add `OPENAI_API_KEY=` to `.env.example`.**
- Both Tier 2 (episodic) and Tier 3 (facts/docs) use this one embedder so vectors are comparable
  and the dimension is consistent. (See Design Decision D1 if we want to avoid OpenAI.)

### npm packages (foundation)

| Package | Version (latest as of plan) | Why |
|---|---|---|
| `better-sqlite3` | `^12.10.0` | Synchronous SQLite driver. Also the engine `SqliteSaver` uses, so one native build. |
| `sqlite-vec` | `^0.1.9` | Vector similarity (`vec0` virtual tables) inside the same SQLite file. No server, no extra process. |

> `better-sqlite3` is a native module — `pnpm-workspace.yaml`'s `allowBuilds:` list must add it
> (alongside the existing `esbuild`) so its postinstall build runs. Same for any native dep.

---

## 2. Tier 1 — Short-term / Working Memory (persistent checkpoints)

**Goal:** conversation context survives a CLI restart. Today `MemorySaver` is in-RAM, so quitting
loses the thread.

### 2.1 Files that change

| File | Change |
|---|---|
| **`src/memory/checkpointer.ts`** (new) | Construct and memoize a single `SqliteSaver` from `./.data/checkpoints.db`. Export `getCheckpointer()`. |
| **`src/chat.ts`** | In `build()`, replace `checkpointer: new MemorySaver()` → `checkpointer: getCheckpointer()`. Drop the `MemorySaver` import. |
| **`src/engines/langgraph.ts`** | Same swap in its `build()`. The langgraph worker's per-job thread (`lg-NNN`) now persists too — lets an interrupted/`awaiting` job resume across a restart (today it can't). |
| **`.gitignore`** | add `.data/` |
| **`pnpm-workspace.yaml`** | add `better-sqlite3` to `allowBuilds:` |

```ts
// src/memory/checkpointer.ts
import { SqliteSaver } from '@langchain/langgraph-checkpoint-sqlite';
let saver: SqliteSaver | undefined;
export function getCheckpointer() {
  return (saver ??= SqliteSaver.fromConnString(dataFile('checkpoints.db')));
}
```

### 2.2 npm package

| Package | Version | Notes |
|---|---|---|
| `@langchain/langgraph-checkpoint-sqlite` | `^1.0.1` | LangGraph's official SQLite checkpointer. Compatible with `@langchain/langgraph-checkpoint@1.0.4` already present. Pulls in `better-sqlite3`. |

### 2.3 Data model / storage

`SqliteSaver` owns its schema (`checkpoints`, `writes` tables keyed by `thread_id` + checkpoint id).
We do not hand-write it. Each `thread_id` is an independent conversation timeline. **No code in the
conductor changes** — it already passes `{ configurable: { thread_id } }`; persistence is transparent.

### 2.4 Thread-id scheme (forward-compatible)

Today: the single constant `CLI_THREAD_ID = 'zero:cli:main'`. Adopt ARCHITECTURE's scheme now so the
Slack adapter is a drop-in later:

```
thread_id = `${agent}:${channel}:${thread_ts ?? 'root'}`   // e.g. zero:cli:root, zero:D0DENNIS:1718-42
```

Keep `CLI_THREAD_ID` as the v0 value of this scheme — no behavior change, just a documented format.

### 2.5 Retrieval trigger

**Passive / automatic.** The checkpointer loads the prior `messages` array for a `thread_id` before
the model runs — no tool call, no prompt change. This tier is pure infrastructure.

### 2.6 Compaction (anchored window + running summary) — **phase 4, optional**

ARCHITECTURE §1 wants token-aware trimming so the window stays bounded forever. This is **not needed
for persistence** and adds real complexity, so it is deferred to its own phase:

- Use `trimMessages` (token-aware) from `@langchain/core/messages`, triggered at ~70% of the token
  budget, at clean turn boundaries only (never orphan a `ToolMessage` from its `AIMessage`).
- Maintain a running summary via a **cheap model** (Haiku / gpt-4o-mini) — a second `buildModel`-style
  factory (`buildSummaryModel()`), set by a new `SUMMARY_MODEL` env.
- In LangChain 1.x this is cleanest as **agent middleware** (`createAgent({ middleware: [...] })`)
  with a `beforeModel` hook that rewrites the message list. Flag: confirm the middleware API shape
  against the installed `langchain@1.4.4` before building.
- Because every message is also embedded into the episodic store (Tier 2), summarization loses
  nothing — evicted detail is paged back via `search_conversations()`.

### 2.7 Scoping (company vs private)

Working memory is **always private to a thread** by definition — there is no company-wide working
memory. Company-wide vs private is a Tier 3 concept. Nothing to do here.

---

## 3. Tier 2 — Episodic / Conversational Search ("what did we discuss last week about X?")

**Goal:** a durable, semantically searchable archive of everything *said*, so Zero can answer
recall-style questions even after the message has been compacted/evicted from the live window.

### 3.1 Files that change

| File | Change |
|---|---|
| **`src/memory/episodic.ts`** (new) | `ingestMessage()` (embed + insert) and `searchConversations()` (embed query → vec0 KNN → rows). |
| **`src/conductor.ts`** | In `commit(msg)` (and on user-turn append), call `void ingestMessage(...)` fire-and-forget for each finalized `user` / `assistant` text. This is the "one ingest" hook — non-blocking, errors swallowed so a memory failure never breaks chat. |
| **`src/tools.ts`** | Add `search_conversations` tool (read-only; safe for chat layer). Export it. |
| **`src/chat.ts`** | Add `search_conversations` to the chat agent's `tools` array. |
| **`src/persona.ts`** | Add one line to `ZERO_CHAT_PROMPT` describing when to use `search_conversations` ("to recall something said earlier than the current window"). |

### 3.2 Data model

`sqlite-vec` splits content and vector across two tables (vec0 holds only the embedding + rowid):

```sql
-- metadata + raw text
CREATE TABLE IF NOT EXISTS episodic (
  id         INTEGER PRIMARY KEY,
  thread_id  TEXT NOT NULL,          -- zero:cli:root, zero:D0DENNIS:1718-42, …
  channel    TEXT,                   -- parsed from thread_id (cli / C0ENG / D0DENNIS)
  scope      TEXT NOT NULL,          -- 'company' | 'zero' (private)  — see §3.5
  role       TEXT NOT NULL,          -- 'user' | 'assistant'
  speaker    TEXT,                   -- human/user id when known (multi-user later)
  text       TEXT NOT NULL,
  ts         TEXT NOT NULL           -- ISO timestamp
);
-- vectors (vec0 virtual table), rowid ↔ episodic.id
CREATE VIRTUAL TABLE IF NOT EXISTS episodic_vec USING vec0(
  embedding float[1536]
);
```

- **Chunking:** chat messages are short — embed one row per message. (When a message exceeds ~1–2k
  tokens, split into ~512-token chunks sharing a `parent_id`; a `chunk_index` column. Not needed for
  v0 CLI traffic.)
- **Hybrid retrieval (ARCHITECTURE's "key finding"):** vector KNN for fuzzy recall, plus a SQL
  `WHERE thread_id/channel/ts BETWEEN` filter for precise fetch ("the Tuesday thread"). Both are one
  query against this table.

### 3.3 The tool

```ts
search_conversations({ query, channel?, since?, limit? })
// embed(query) → SELECT text, role, ts, thread_id FROM episodic
//   JOIN episodic_vec ON id=rowid
//   [WHERE channel = ? AND ts >= ? AND scope visible]
//   ORDER BY vec_distance_cosine(embedding, ?) LIMIT k(=6)
// returns compact "[2026-06-01 you] …\n[2026-06-01 Zero] …" blocks
```

### 3.4 Retrieval trigger

**Explicit tool call** (primary). Zero calls `search_conversations` when a question reaches past the
live window. This matches the "memory paging" mental model — page in on demand, keep the window small.

- **Optional passive top-k injection** (Design Decision D3): before each turn, embed the user's
  message, pull top-k past exchanges, and prepend them as context. Cheaper for the model to use but
  costs an embedding call + tokens on *every* turn and risks irrelevant noise. Recommend **explicit
  tool first**, add passive injection only if recall in practice is poor.

### 3.5 Company-wide vs private scoping

- Each row carries a `scope` column: `'zero'` (this agent's private memory of a DM) or `'company'`
  (shared channels every agent can search). In v0 single-CLI, everything is `scope='zero'` — but the
  column + the `WHERE scope IN (...)` filter exist from day one so the Slack multi-agent rollout
  (channels = `company`, DMs = private) is a config flip, not a migration.
- Derivation rule: `channel` prefix decides scope (`D…`=DM→private, `C…`/`G…`=channel→company),
  exactly as ARCHITECTURE's `(channel, thread_ts)` scheme implies.

### 3.6 npm packages

None beyond the foundation (`better-sqlite3`, `sqlite-vec`, `@langchain/openai` already present).

---

## 4. Tier 3 — Semantic Facts + Company Knowledge (RAG)

**Goal:** `remember()` / `recall()` / `update()` / `forget()` over distilled facts, scoped
company-wide or private, **plus** ingestion of company documents for retrieval. ARCHITECTURE unifies
facts and docs into one vector store, two collections.

### 4.1 Backend decision — DIY-on-sqlite-vec vs mem0 (needs human sign-off, D2)

ARCHITECTURE §3+4 says **"Decision: use mem0."** But mem0 brings its own vector DB + an extra
LLM-extraction service and is a heavier dependency than this single-process CLI currently warrants.
**The abstraction boundary is the tool interface, not the backend** (ARCHITECTURE states this
explicitly). So the recommendation:

- **Build v0 on the same `sqlite-vec` store** behind the four tools — ~150 lines, zero new infra,
  fully under our control, and it reuses the foundation from §1.
- **Keep `remember/recall/update/forget` as the only surface**, so swapping to `mem0ai` (or Graphiti
  later) is an implementation change behind unchanged tools — exactly the upgrade path ARCHITECTURE
  describes.

This plan documents **both**; default to DIY unless D2 says otherwise.

### 4.2 Files that change

| File | Change |
|---|---|
| **`src/memory/semantic.ts`** (new) | `remember()`, `recall()`, `update()`, `forget()` over the `facts` table; dedup-on-upsert (embed → if a near-duplicate above a cosine threshold exists, update it instead of inserting). |
| **`src/memory/documents.ts`** (new) | `ingestDocument(path|text, meta)` — chunk → embed → insert into `documents`; `searchDocuments(query)` for RAG. |
| **`src/memory/ingest-docs.ts`** (new, script) | CLI entry to bulk-ingest a folder of company docs (runbooks, ARCHITECTURE.md, etc.). Wire as `pnpm ingest:docs <dir>`. |
| **`src/tools.ts`** | Add `remember`, `recall`, `update_memory`, `forget`, and `search_docs` tools. |
| **`src/chat.ts`** | Add `remember/recall/update_memory/forget/search_docs` to the chat agent's tools. |
| **`src/persona.ts`** | Extend `ZERO_CHAT_PROMPT`: when to remember (durable facts/preferences), recall (look up a known fact), and that company vs private scope exists. |
| **`package.json`** | add `"ingest:docs": "dotenvx run … -- tsx src/memory/ingest-docs.ts"` script. |

### 4.3 Data model

```sql
CREATE TABLE IF NOT EXISTS facts (
  id         INTEGER PRIMARY KEY,
  fact       TEXT NOT NULL,
  scope      TEXT NOT NULL,          -- 'company' | 'zero' | 'user:<id>'   (see §4.6)
  source     TEXT,                   -- 'dennis said in cli' / thread_id
  confidence REAL DEFAULT 1.0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE VIRTUAL TABLE IF NOT EXISTS facts_vec USING vec0(embedding float[1536]);

CREATE TABLE IF NOT EXISTS documents (
  id          INTEGER PRIMARY KEY,
  doc_path    TEXT NOT NULL,         -- source file or URL
  chunk_index INTEGER NOT NULL,
  type        TEXT,                  -- 'runbook' | 'architecture' | 'code' | …
  text        TEXT NOT NULL,
  scope       TEXT NOT NULL DEFAULT 'company',
  last_updated TEXT NOT NULL
);
CREATE VIRTUAL TABLE IF NOT EXISTS documents_vec USING vec0(embedding float[1536]);
```

### 4.4 The tools

```ts
remember({ fact, scope? })       // scope default 'zero'; embed → dedup-check → upsert
recall({ query, scope? })        // embed → KNN within visible scopes → top-k facts
update_memory({ query, newFact })// find nearest fact by similarity → overwrite text + updated_at
forget({ query, scope? })        // find nearest fact → delete (gated — see D6)
search_docs({ query, type? })    // RAG over documents collection → top-k chunks
```

- **Dedup-on-upsert** (the race-condition story in ARCHITECTURE): before insert, KNN the new fact; if
  the closest existing fact is within a cosine threshold (e.g. `distance < 0.15`), update it instead
  of inserting a duplicate. This is what makes simultaneous "refund policy is 7 days" writes from
  multiple agents converge instead of duplicating.

### 4.5 Retrieval trigger

- **`recall` / `search_docs`: explicit tool calls** — Zero pulls facts/docs when relevant.
- **Passive fact injection (recommended, D3):** facts are short and high-value, so injecting the
  top-k facts for the active scope into the system prompt each turn is usually worth it (unlike full
  episodic injection). Implement as **agent middleware** or a per-turn `dynamicSystemPrompt` that
  appends a "Things you know:" block. Keep it bounded (top-5, token cap). Docs (RAG) stay
  explicit-tool only — too large to inject blindly.
- This means `persona.ts`'s currently-static `ZERO_CHAT_PROMPT` needs a composition seam: a
  `buildChatPrompt(injectedFacts)` function, or middleware. (Today the prompt is passed once at
  `createAgent` time — passive injection requires moving to a per-turn computed prompt.)

### 4.6 Company-wide vs private scoping

| Scope value | Meaning | Who reads | Who writes |
|---|---|---|---|
| `company` | shared company truth (policies, conventions) | every agent | any agent (dedup-upsert) |
| `zero` | this agent's private memory | only Zero | only Zero |
| `user:<id>` | per-agent, per-human (e.g. "Dennis prefers TypeScript") | Zero, for that human | Zero |

- `recall`/`search` filter `WHERE scope IN (visibleScopes)` — for v0 CLI that's
  `('company','zero','user:dennis')`. The scope a `remember` writes to defaults to `zero` but the
  tool exposes `scope` so Zero (or the user) can mark a fact company-wide.
- Maps cleanly onto mem0's user/agent/run identifiers if/when we swap backends (D2).
- **Documents are `company` scope by default** (runbooks/architecture are shared knowledge).

### 4.7 Document ingestion

- `ingest-docs.ts`: walk a directory (reuse the `walkFiles` + `IGNORED_DIRS` logic already in
  `tools.ts` — extract it to a shared util rather than duplicating), read text files, chunk to
  ~512-token windows with ~50-token overlap, embed, insert into `documents`. Store `doc_path`,
  `chunk_index`, `type`, `last_updated`.
- Re-ingest is idempotent: delete existing rows for a `doc_path` before re-inserting (so editing a
  runbook updates cleanly).
- v0 sources to seed: `ARCHITECTURE.md`, `README`-style docs, and optionally the `src/` tree as
  `type='code'` (gives Zero RAG over its own codebase — complements the live `grep`/`read_file`).

### 4.8 npm packages

| Package            | Version  | When                                    |
|--------------------|----------|-----------------------------------------|
| (none new for DIY) | —        | reuses foundation + `@langchain/openai` |
| `mem0ai`           | `^3.0.6` | **only if** D2 chooses mem0 over DIY    |

---

## 5. Concrete implementation order (phases)

Each phase is independently shippable and leaves the app working.

**Phase 0 — Foundation & decisions (½ day)**
1. Get human answers to the Design Decisions in §6 (esp. D1 embeddings key, D2 backend, D3 passive vs explicit).
2. Add `OPENAI_API_KEY=` to `.env.example`; add `.data/` to `.gitignore`; add `better-sqlite3` to `allowBuilds`.
3. Build `src/memory/paths.ts`, `db.ts`, `embeddings.ts`. Add `better-sqlite3`, `sqlite-vec` deps.

**Phase 1 — Working memory persistence (Tier 1 core)**
4. Add `@langchain/langgraph-checkpoint-sqlite`. Build `checkpointer.ts`.
5. Swap `MemorySaver` → `getCheckpointer()` in `chat.ts` and `engines/langgraph.ts`.
6. Manual test: chat, quit, restart, confirm the thread continues. **Smallest, highest-value win — do first.**

**Phase 2 — Episodic archive (Tier 2)**
7. `episodic.ts` (ingest + search). Migrations for `episodic` / `episodic_vec`.
8. Wire `ingestMessage()` into `conductor.ts` `commit()` (fire-and-forget).
9. Add `search_conversations` tool → `tools.ts` + `chat.ts` + persona line.
10. Test: discuss X, restart, ask "what did we say about X?" → answered from the archive.

**Phase 3 — Semantic facts (Tier 3a)**
11. `semantic.ts` with dedup-upsert. Migrations for `facts` / `facts_vec`.
12. Add `remember/recall/update_memory/forget` tools → `tools.ts` + `chat.ts`.
13. Persona guidance on remembering durable facts. Test the full curate→recall loop.
14. (If D3 = passive) add the system-prompt fact-injection seam (`buildChatPrompt` / middleware).

**Phase 4 — Company knowledge / RAG (Tier 3b)**
15. `documents.ts` + `ingest-docs.ts` script + `search_docs` tool. Seed-ingest `ARCHITECTURE.md` & docs.
16. Test RAG recall over ingested docs.

**Phase 5 — Compaction (Tier 1 optional)**
17. `buildSummaryModel()` + `SUMMARY_MODEL` env. Token-aware trim + running-summary middleware.
18. Persist each summary as an episodic "chapter."

**Phase 6 — Scope hardening for multi-surface (pre-Slack)**
19. Implement `thread_id → (channel, scope)` parsing as a shared util; thread it through ingest +
    search filters. Confirm `company`/`zero`/`user:<id>` filtering end-to-end.

---

## 6. Design decisions that need a human answer first

> These genuinely block or materially change the build — answer before Phase 0 closes.

- **D1 — Embeddings provider & key.** ARCHITECTURE decided OpenAI `text-embedding-3-small` (1536 dims,
  the dimension is baked into the schema). This needs an `OPENAI_API_KEY` (new external dependency +
  per-embedding cost on every message ingested). **Confirm OpenAI, or choose a local embedder**
  (e.g. Transformers.js `all-MiniLM-L6-v2`, 384 dims, free/offline but lower quality and a different
  baked dimension). *Recommendation: OpenAI, per the existing decision.*

- **D2 — Facts backend: DIY-on-sqlite-vec vs mem0.** ARCHITECTURE says "use mem0," but for a
  single-process CLI the DIY layer behind the same four tools is lighter and swappable. **Pick one.**
  *Recommendation: DIY now, mem0/Graphiti behind the same tool interface later.*

- **D3 — Passive injection vs explicit-tool-only.** Should recalled facts (and/or episodic hits) be
  auto-injected into the system prompt every turn, or only fetched when Zero calls a tool? Passive is
  easier for the model to use but costs tokens + an embedding call per turn and risks noise.
  *Recommendation: facts passive (top-5, bounded); episodic + docs explicit-tool.* This also decides
  whether `persona.ts` must move from a static string to a per-turn computed prompt.

- **D4 — Identity of "company" vs "private" in single-user CLI.** Today there is one user (Dennis) and
  one surface. What is `scope='company'` before Slack exists, and what is the current user id for
  `user:<id>` facts? Need a `CURRENT_USER` notion (env or constant) so scoping is meaningful now.
  *Recommendation: hardcode `user:dennis` + treat explicitly-marked facts as `company`; everything
  else `zero`.*

- **D5 — Auto fact-extraction (a "memory gate") vs explicit `remember()` only.** ARCHITECTURE's
  pipeline runs a memory gate on *every* message (extra cheap-LLM call per turn) to distill facts
  automatically. Or we rely solely on Zero choosing to call `remember()`. *Recommendation: explicit
  `remember()` first (zero added cost/latency); add an extraction gate in a later phase if recall
  quality needs it.*

- **D6 — Memory permissions: can Zero `forget()`/`update()` facts a human stated?** ARCHITECTURE lists
  this as an open question. Risk: an agent silently deleting/altering a human-asserted company fact.
  *Recommendation: allow `update`, but make `forget` on `company` scope require confirmation (or
  soft-delete with a `deleted_at` tombstone) rather than a hard delete.*

- **D7 — Should background workers get memory tools?** Only the `langgraph` worker engine shares our
  LangChain `tool()` objects; `claude`/`codex` run in subprocesses and would need MCP to reach the
  store. Do background tasks need `recall`/`remember`, or is memory a chat-layer concern in v0?
  *Recommendation: chat-layer only for v0; revisit MCP-exposed memory for workers later.*

- **D8 — Persistence location & git hygiene.** Confirm `./.data/` (gitignored) is the right home for
  `zero.db` + `checkpoints.db`. Should anything (e.g. an ingested-docs index) ever be committed or
  shared between machines? *Recommendation: everything in gitignored `.data/`; docs are re-ingested
  from source, never committed as an index.*

- **D9 — Compaction now or later (and which cheap model).** Persistence (Phase 1) does **not** require
  compaction; the live window just grows. Decide whether Phase 5 is in scope for this milestone and
  which model backs `buildSummaryModel()` (Haiku vs gpt-4o-mini). *Recommendation: defer to Phase 5;
  Haiku for the summary model.*

---

## 7. Summary of all file changes

**New files (`src/memory/`):** `paths.ts`, `db.ts`, `embeddings.ts`, `checkpointer.ts`,
`episodic.ts`, `semantic.ts`, `documents.ts`, `ingest-docs.ts`. (Plus, if D9 in scope, a
`summary.ts` / middleware module.)

**Edited files:**
- `src/chat.ts` — checkpointer swap; register `search_conversations`, `remember`, `recall`,
  `update_memory`, `forget`, `search_docs`; (if D3=passive) per-turn prompt seam.
- `src/engines/langgraph.ts` — checkpointer swap.
- `src/conductor.ts` — episodic `ingestMessage()` hook in `commit()` (+ user-turn append).
- `src/tools.ts` — six new memory tools; extract shared `walkFiles`/`IGNORED_DIRS` util.
- `src/persona.ts` — memory-tool guidance; (if D3=passive) `buildChatPrompt()` composition.
- `src/model.ts` — (Phase 5) add `buildSummaryModel()`.
- `package.json` — deps (`better-sqlite3`, `sqlite-vec`, `@langchain/langgraph-checkpoint-sqlite`,
  optional `mem0ai`); `ingest:docs` script.
- `.env.example` — `OPENAI_API_KEY=` (+ optional `SUMMARY_MODEL=`).
- `.gitignore` — `.data/`.
- `pnpm-workspace.yaml` — `better-sqlite3` in `allowBuilds`.

**No changes:** `src/ui/*` (memory is invisible to the renderer), `src/engines/{claude,codex}.ts`,
`src/engines/guard.ts`, `src/jobs.ts` (its SQLite migration is a separate ARCHITECTURE item, not
memory).

---

## 8. Alignment with ARCHITECTURE.md

This plan implements ARCHITECTURE §"Memory Layers" tiers 1–4 with two deliberate, documented
deviations for the current single-process CLI reality:

1. **Vector backend = `sqlite-vec` (one local file), not mem0**, for v0 — kept behind the
   `remember/recall/update/forget` tool interface that ARCHITECTURE itself names as the true
   abstraction boundary, so mem0/Graphiti remain drop-in upgrades (Design Decision D2).
2. **Facts/episodic share one SQLite DB; checkpoints get a second** — pragmatic for a single process;
   the tool/function surfaces are the swap points if these later move to separate services.

Everything else — OpenAI 1536-dim embeddings, hybrid retrieval, scope model
(`company`/`{agent}`/`{agent}:user:{id}`), self-managed memory tools, the
`{agent}:{channel}:{thread_ts}` thread scheme, "one ingest / three consumers" — follows ARCHITECTURE
directly.
