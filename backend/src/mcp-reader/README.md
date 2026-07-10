# atlas-mcp-reader

A standalone, READ-ONLY MCP server that lets an operator's MCP client (Claude Desktop, etc) inspect
production Atlas job diagnostics — status, thread failures, transcripts, raw Claude session JSONL,
`/context` files, and worktree files — without giving the client shell/DB access.

It reuses the backend's TypeORM entities to read the same Postgres the Nest backend uses, but is a
**separate process**: it is never imported by, or wired into, any Nest module. It connects with its own
SELECT-only Postgres role and never writes to the database or the filesystem.

## What it is NOT

- Not part of the Nest app (no `AppModule` import, no HTTP route on the main API).
- Not a write path — every tool is a read. No mutation, no migrations run from here.
- Not internet-facing — bind is `0.0.0.0:<port>` on an internal network only; the deployment/infra layer
  is responsible for not publishing this port publicly.

## Env vars

| Var                      | Required | Default                      | Notes                                                        |
| ------------------------ | -------- | ---------------------------- | ------------------------------------------------------------ |
| `MCP_READER_PORT`        | no       | `4100`                       | HTTP listen port                                             |
| `MCP_READER_API_KEY`     | **yes**  | —                            | static key clients send as `x-api-key`                       |
| `MCP_READER_PG_HOST`     | **yes**  | —                            |                                                              |
| `MCP_READER_PG_PORT`     | no       | `5432`                       |                                                              |
| `MCP_READER_PG_USER`     | **yes**  | —                            | should be a SELECT-only role                                 |
| `MCP_READER_PG_PASSWORD` | **yes**  | —                            |                                                              |
| `MCP_READER_PG_DB`       | **yes**  | —                            |                                                              |
| `MCP_READER_PG_SSL`      | no       | `disable`                    | `disable` \| `verify-full`                                   |
| `AGENT_HOME_ROOT`        | no       | `/srv/atlas/data/agent-home` | root for sandbox JSONL + `/context`                          |
| `REPOS_ROOT`             | no       | `/srv/atlas/data/repos`      | root for worktrees (mounted read-only at the same host path) |

Missing required vars fail fast at boot with a clear error.

## Build & run

```sh
cd backend
pnpm build:mcp-reader     # bundles src/mcp-reader/main.ts -> dist/mcp-reader.js (esbuild, CJS)
node dist/mcp-reader.js   # runs the server
```

The bundle is CJS (not ESM) — TypeORM's transitive deps rely on `__dirname`, which an ESM bundle doesn't
provide. `dist/` is gitignored; nothing here is committed.

## Auth

Every HTTP request must carry `x-api-key: <MCP_READER_API_KEY>`. Compared with `crypto.timingSafeEqual`
(constant-time; a length mismatch fails closed without ever calling `timingSafeEqual`, so no early-exit
timing signal is exposed either). A missing/mismatched key gets HTTP 401 `{"error":"unauthorized"}` and an
audit line; only an authorized request reaches the MCP transport.

## Transport

Streamable-HTTP (`@modelcontextprotocol/sdk`), one stateful session per `mcp-session-id` — connect with
`initialize` first, then reuse the session id for subsequent calls. Mirrors the session-map pattern in
`app/sandbox/image/mcp-hub-server.ts`.

## Redaction

Every tool result is passed through `redactSecrets()` (see `redact.ts`) immediately before
JSON-serializing it into the MCP response — the single choke point. It masks OpenAI/GitHub/AWS-style keys,
JWTs, connection-string credentials, PEM private key blocks, and generic
`api_key=`/`secret=`/`token=`/`password=` assignments, plus any object key literally named one of those.

## Path jailing

Filesystem-touching tools (`atlas_context_read`, `atlas_worktree_tree`, `atlas_worktree_file`,
`atlas_session_raw`) resolve every path through `resolveJailed()` (see `path-jail.ts`), which rejects any
path that would escape the job's context/worktree/sandbox root — including `..` segments and symlinks that
resolve outside the jail.

## Audit

One JSON line to stdout per tool call (`ok: true/false`, `tool`, `jobId`, `orgId`, `error?`) and per
rejected auth attempt. No file, no DB — stdout only; the deployment's log collector owns retention.

## The 8 tools

1. `atlas_job_overview(jobId)` — job status fields + thread list with a derived one-line failure summary.
2. `atlas_thread_failure(jobId, threadId?)` — full typed `terminal_record` for one or all threads.
3. `atlas_job_transcript(jobId, {kind?, source?, tail?, since?})` — operator-facing message transcript.
4. `atlas_session_raw(jobId, {sessionId?, raw?, role?, thinking?, text?, tools?, errors?, tail?, since?, grep?})`
   — raw Claude session JSONL: list sessions, return one raw (`raw:true`), render one (mirrors
   `atlas-tx show`), or grep across sessions.
5. `atlas_list_jobs({repoId?, orgId?, status?, limit?})` — jobs across ALL orgs (no org scoping).
6. `atlas_context_read(jobId, path?)` — the job's durable `/context` dir (tree listing or file contents).
7. `atlas_worktree_tree(jobId, subpath?)` — the job's git worktree file tree (skips `.git`, `node_modules`).
8. `atlas_worktree_file(jobId, path)` — one worktree file's contents.

Tree listings are capped at 2,000 entries / 10 levels deep; file reads are capped at 2MB — both to keep a
single tool response bounded. `atlas_list_jobs` defaults to the 50 most recently created jobs.
