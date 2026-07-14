# @workspace/codex-sdk

A standalone, typed TypeScript SDK for [OpenAI Codex](https://github.com/openai/codex), built
directly on the `codex app-server` JSON-RPC-2.0-over-stdio protocol.

Unlike the official thin `@openai/codex-sdk` (which parses JSONL from the `codex exec` CLI), this
package speaks the raw app-server wire protocol, giving you:

- Typed **thread** and **turn** control (`startThread` / `resumeThread` / `startTurn`).
- Mid-turn **steer** — inject additional input into the currently running turn.
- Per-call **approval interception** — a write-guard seam: every command-execution / file-change /
  permission approval request is routed to your handler, which returns a decision.
- A rich, discriminated **event stream** (`CodexEvent`) with a `raw` passthrough on every event so
  nothing the server emits is ever silently dropped.

## Atlas-agnostic / submodule-ready

This package has **zero Atlas / monorepo coupling** by design. It has no `@workspace/*` imports, no
NestJS, no Redis, and no Atlas domain types. Its only runtime dependencies are Node.js built-in
modules. Auth is fully generic: you supply a `codexHome` directory path (a `CODEX_HOME`-shaped
directory containing `auth.json`) and nothing more. It can be lifted out into its own git submodule
and reused in any project as-is.

## Install

```sh
pnpm add @workspace/codex-sdk
```

Requires the `codex` binary on `PATH`. If it lives somewhere else, pass `codexPathOverride` with the
full path to the binary **and** `args: ['app-server']` — `codexPathOverride` only replaces the
executable; it does not assume the target is `codex` and add the subcommand for you (this also lets
tests point it at a bare script that already speaks the app-server protocol, with no subcommand at
all):

```ts
new CodexClient({
  codexHome: '/path/to/CODEX_HOME',
  codexPathOverride: '/opt/codex/bin/codex',
  args: ['app-server'],
});
```

## Quick example

```ts
import { CodexClient, type CodexEvent, type CodexApprovalRequest } from '@workspace/codex-sdk';

const client = new CodexClient({ codexHome: '/path/to/CODEX_HOME' });
await client.init();

const { threadId } = await client.startThread({ cwd: process.cwd(), sandbox: 'workspaceWrite' });

let liveTurnId: string | undefined;

const result = await client.startTurn(
  threadId,
  [{ type: 'text', text: 'Refactor the auth module and run the tests.' }],
  {
    onEvent: (e: CodexEvent) => {
      if (e.type === 'turnStarted') liveTurnId = e.turnId;
      if (e.type === 'agentMessageDelta') process.stdout.write(e.delta);
    },
    // Write-guard seam: approve or block each side-effecting action.
    onApproval: (req: CodexApprovalRequest) =>
      req.kind === 'fileChange' ? 'accept' : 'decline',
  },
  { effort: 'high' },
);

console.log(result.status, result.usage);

// Mid-turn steer (from another context, while the turn above is still running):
// await client.steer(threadId, liveTurnId!, [{ type: 'text', text: 'Also update the changelog.' }]);
// Or interrupt it:
// await client.interrupt(threadId, liveTurnId!);

await client.close();
```

`startTurn` resolves with a `CodexTurnResult` when the turn completes — including on a `failed` or
`interrupted` status (inspect `result.status` / `result.error`). It only rejects on transport-level
failures (the child process died, a malformed response, or a JSON-RPC error such as an effort the
server refuses).

### Detecting a refreshed auth token

Codex rewrites `auth.json` in place when it refreshes an access token. After a turn you can read it
back so your own storage can persist the refreshed secret:

```ts
const authJson = client.readAuthHome(); // string contents of {codexHome}/auth.json, or null
```

## Protocol primer

Communication is JSON-RPC 2.0 over the child process's stdio, framed as newline-delimited JSON (one
complete JSON object per line, both directions; the `"jsonrpc"` field is omitted on the wire). The
first call is always `initialize`; the SDK then acks with an `initialized` notification before any
other call. The server sends three kinds of message: responses to our requests (correlated by `id`),
one-way notifications (mapped into the `CodexEvent` union), and server-initiated **requests** —
notably the approval requests — which the SDK answers on your behalf via your `onApproval` handler
(defaulting to `accept` when none is supplied).

## Low-level access

`AppServerClient` is exported for callers who want the raw JSON-RPC peer (`request` / `notify` /
`onNotification` / `onServerRequest`) without the high-level thread/turn modeling.

## License

ISC
