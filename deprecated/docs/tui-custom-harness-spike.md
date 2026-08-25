# Atlas custom harness: subscription OAuth and framework choice

Research snapshot: 2026-08-24. External claims below use first-party OpenAI, Vercel, LangChain, and OpenTUI sources. Atlas was inspected read-only; no credential values were read or printed.

## Decision

For the original minimal model/tool-loop spike, **Vercel AI SDK Core** had the better DX. The requirement is now full Claude Code parity, including rewind/fork, durable human intervention, pre-tool policy, crash recovery, and workspace restoration. Under that stricter requirement, use a hybrid:

- AI SDK Core performs exactly one streamed model step and normalizes provider/tool protocol.
- A thin LangGraph graph owns resumable control flow, checkpoints, forks, and interrupts.
- Atlas remains authoritative for the append-only event log, conversation projections, permissions, scheduling, credentials, and workspace snapshots.

Do not let `ToolLoopAgent` own the parity loop. Keep graph state small—IDs, cursors, pending actions, and snapshot references—so LangGraph does not duplicate Atlas's canonical conversation state. See [Full-parity harness controls](./tui-full-parity-harness-controls.md) for the detailed capability analysis.

The model transport and loop framework are independent choices. A small `ChatGPT Codex Responses -> AI SDK LanguageModelV3` adapter can run inside the LangGraph model node.

## What the Claude spike established

The companion spike made real Anthropic calls with both of the user's Claude subscription identities:

| Harness | Work / Teams OAuth | Personal / Max OAuth |
| --- | --- | --- |
| Vercel AI SDK | Passed | Passed |
| LangGraph | Passed | Passed |

Each case completed the same two-model-call, one-tool-call loop. The work credential came from Claude Code's normal credential storage; the personal credential was selected from Atlas's encrypted account vault and decrypted only in memory. No credential was copied into source or output.

This proves present-day transport compatibility, not a permanent entitlement or supported generic API contract. Anthropic officially supports using Claude subscription credentials with Claude Code and the Claude Agent SDK, while a raw third-party loop depends on current OAuth behavior and may change. [Claude account login](https://support.claude.com/en/articles/13189465-log-in-to-your-claude-account), [Claude Agent SDK with a Claude plan](https://support.claude.com/en/articles/15036540-use-the-claude-agent-sdk-with-your-claude-plan)

Observed DX matched the API shapes: Vercel AI SDK exposed bearer auth and a compact typed loop directly. LangGraph made the graph topology and node identity explicit, but required more message projection and Anthropic-client glue for the same minimal loop.

## Can a ChatGPT/Codex OAuth token make a raw GPT call?

Yes, in the narrow technical sense that matters for this spike: OpenAI's own Codex client uses a ChatGPT OAuth access token to call a Responses-compatible GPT endpoint. This is not the public Platform API and is not a promise that arbitrary third-party clients will remain supported.

OpenAI documents two distinct routes:

| Login mode | Endpoint | Billing/access surface |
| --- | --- | --- |
| ChatGPT-managed Codex login | `https://chatgpt.com/backend-api/codex/responses` | ChatGPT/Codex subscription or workspace access |
| Platform API key | `https://api.openai.com/v1/responses` | Separately billed API usage |

The split is described by OpenAI's engineering article on the Codex loop and encoded in the official client. [Unrolling the Codex agent loop](https://openai.com/index/unrolling-the-codex-agent-loop/), [Codex model-provider source](https://github.com/openai/codex/blob/main/codex-rs/model-provider-info/src/lib.rs)

For ChatGPT-managed auth, current Codex source builds these request headers:

```http
Authorization: Bearer <tokens.access_token>
ChatGPT-Account-ID: <tokens.account_id>
Content-Type: application/json
Accept: text/event-stream
```

The request is a streaming Responses request to `/responses`. Current Codex source provides the bearer token and account-routing header, and its Responses client consumes Server-Sent Events. [Codex auth provider](https://github.com/openai/codex/blob/main/codex-rs/model-provider/src/auth.rs), [Codex Responses client](https://github.com/openai/codex/blob/main/codex-rs/codex-api/src/endpoint/responses.rs)

The minimum safe conclusion is therefore:

- A current ChatGPT Codex credential is mechanically capable of authenticating GPT inference through the Codex backend.
- This does **not** turn the OAuth token into a general `api.openai.com` API key. OpenAI states that ChatGPT and API billing are separate. [OpenAI billing guidance](https://help.openai.com/en/articles/8156019-is-api-usage-included-in-chatgpt-subscriptions-even-if-i-have-a-paid-chatgpt-account)
- The usable models, request fields, rate limits, and product policy are those of the Codex backend, not arbitrary Platform API entitlements.
- Raw third-party use of the cached token is an implementation-dependent personal spike. OpenAI's supported embedding surface is Codex App Server, which owns login, token refresh, history, approvals, and agent events. [Codex App Server](https://github.com/openai/codex/blob/main/codex-rs/app-server/README.md)

### Credential shape Atlas already understands

Atlas's backend-era Codex auth code persists the full `auth.json` document as AES-GCM ciphertext. Its non-secret structural shape is:

```ts
type CodexAuth = {
  OPENAI_API_KEY: string | null;
  auth_mode?: "chatgpt";
  tokens: {
    id_token: string;
    access_token: string;
    refresh_token: string;
    account_id?: string | null;
  };
  last_refresh?: string;
};
```

That shape matches the official Codex storage type, although OpenAI does not present `auth.json` as a stable third-party API. Codex may store credentials in the OS credential store instead of the file depending on configuration. [Official auth storage source](https://github.com/openai/codex/blob/main/codex-rs/login/src/auth/storage.rs)

Relevant Atlas source:

- `backend/src/host/agent-credentials/oauth/codex-oauth.client.ts` creates and refreshes the OAuth token set and assembles `auth.json`.
- `backend/src/host/agent-credentials/oauth/codex-auth.service.ts` validates the shape and decodes identity metadata without verifying the JWT as an authorization decision.
- `backend/src/host/agent-credentials/agent-credential.service.ts` encrypts the complete blob at rest.
- `packages/codex-sdk/src/codex-client.ts` points `codex app-server` at an isolated `CODEX_HOME` and reads back a refreshed `auth.json` after a turn.

The active local TUI is not yet symmetrical: `tui/src/auth/account-vault.service.ts` implements Claude accounts only, `tui/src/auth/engine-home.service.ts` merely creates the shared Codex home, and `tui/src/engine/engine.module.ts` registers only the Claude engine. The Codex app-server adapter exists in `packages/agent-engine`, but it is not wired into the current TUI module. Documentation and spikes should not describe the backend-era Codex vault as active TUI behavior.

### AI SDK feasibility

Vercel's OpenAI provider uses the Responses API by default and accepts a custom `baseURL`, bearer `apiKey`, arbitrary headers, and custom `fetch`. That is enough surface area to target the Codex backend and add the account header. [Vercel OpenAI provider](https://ai-sdk.dev/providers/ai-sdk-providers/openai)

An illustrative spike configuration is:

```ts
import { createOpenAI } from "@ai-sdk/openai";
import { streamText } from "ai";

const provider = createOpenAI({
  baseURL: "https://chatgpt.com/backend-api/codex",
  apiKey: auth.tokens.access_token,
  headers: {
    "ChatGPT-Account-ID": auth.tokens.account_id!,
  },
});

const result = streamText({
  model: provider(modelId),
  prompt: "Reply with exactly: Atlas GPT OAuth spike succeeded",
  abortSignal,
  providerOptions: {
    openai: { store: false },
  },
});

for await (const part of result.fullStream) {
  // Never log request headers, auth, or raw credential objects.
}
```

This is a research sketch, not a verified call. The first GPT spike should establish the exact current model ID, required Responses fields, SSE compatibility, token refresh behavior, and whether the stock Vercel OpenAI provider accepts every Codex event. If the backend emits Codex-only parts the provider does not recognize, implement the small custom `LanguageModelV3` adapter instead of hiding protocol rewrites in application code. Vercel publishes the provider specification and custom-provider pattern. [Writing a custom AI SDK provider](https://ai-sdk.dev/providers/community-providers/custom-providers)

Do not copy a live token into source, logs, shell history, fixtures, snapshots, or the new provider object longer than necessary. Read/decrypt at turn start, hold only the parsed fields in memory, and let one credential service own refresh-token rotation.

## Why AI SDK fits Atlas better today

Atlas already has the architectural pieces LangGraph would otherwise supply:

```text
engine/provider stream
        |
        v
engine-specific normalizer
        |
        v
Atlas EngineEvent union
       / \
      v   v
SQLite   ConversationStore
history  live per-thread state
              |
              v
      React useSyncExternalStore
              |
              v
          OpenTUI frame
```

`ConversationStore` owns the live, reactive tail and coalesces deltas to frame cadence. `TurnEventApplier` serializes durable writes, and repositories own transcript/session/turn history. React observes one store per thread through `useSyncExternalStore`. `TurnRunnerService` owns per-thread lanes, turn ordering, rotation, interruption, and finalization. This separation is unusually well matched to AI SDK Core's typed stream and deliberately unopinionated persistence.

### Comparison against Atlas requirements

| Concern | Vercel AI SDK Core | LangGraph JS | Atlas-specific judgment |
| --- | --- | --- | --- |
| First custom loop | `streamText` + tools + `stopWhen`, or `ToolLoopAgent` | State schema, model node, tool node, conditional and back edges | AI SDK is less ceremony for Atlas's existing loop. |
| Streaming | `fullStream` yields typed text, reasoning, tool, finish, and error parts | Event streaming projects messages, state, tools, subgraphs, checkpoints, tasks, and custom events | AI SDK maps more directly to the existing `EngineEvent` normalizer; LangGraph wins node-level inspection. |
| UI reactivity | App consumes the async stream and updates its own store | App consumes graph events/state projections | Both work; neither should own React state. Atlas's external store should remain the UI source of truth. |
| Cancellation | First-class `AbortSignal`, also passed into tool execution | Graph run options accept `AbortSignal` | Both fit. AI SDK maps directly to Atlas's `RunningTurn.interrupt()` through one `AbortController`. |
| Tool approvals | `needsApproval` returns an approval request; the app adds an approval response and calls again | `interrupt()` checkpoints graph state and resumes with `Command` | LangGraph is stronger for durable pause/resume. AI SDK is simpler if Atlas owns pending approval state, as it already owns messages and turns. |
| Persistence/resume | Application-managed | Built-in checkpointers and `thread_id`; checkpoint per graph super-step | AI SDK avoids a second persistence model. LangGraph wins only if graph checkpoints become authoritative. |
| Crash recovery/time travel | Must be designed in Atlas | Built in with a durable checkpointer | This is the clearest reason to adopt LangGraph later. |
| State ownership | Minimal framework state; Atlas stays authoritative | Graph state and checkpoints naturally become authoritative | Layering LangGraph under the existing SQLite/store model risks dual sources of truth. |
| Provider integration | Direct custom provider interface; OpenAI factory exposes base URL, headers, and fetch | Usually a LangChain chat-model adapter, or arbitrary code inside a node | AI SDK is the shorter path for the private Codex Responses transport. |

AI SDK's multi-step loop supports `stopWhen`, per-step `prepareStep`, `onStepFinish`, and a fully manual loop when more control is needed. `ToolLoopAgent` is the convenience wrapper, not a requirement. [AI SDK agents](https://ai-sdk.dev/docs/agents/overview), [loop control](https://ai-sdk.dev/docs/agents/loop-control), [tools and approvals](https://ai-sdk.dev/docs/ai-sdk-core/tools-and-tool-calling)

LangGraph's advantage is durable execution: checkpointers save graph state at super-step boundaries; `interrupt()` can pause indefinitely and resume under the same `thread_id`; event streaming exposes separate typed views for messages, state, tools, subgraphs, checkpoints, and interrupts. A resumed node starts again from its beginning, so effects before an interrupt must be idempotent. [LangGraph persistence](https://docs.langchain.com/oss/javascript/langgraph/persistence), [interrupts](https://docs.langchain.com/oss/javascript/langgraph/interrupts), [event streaming](https://docs.langchain.com/oss/javascript/langgraph/event-streaming)

OpenTUI does not force either choice. Its React binding uses ordinary React composition and hooks, while the renderer owns terminal input/output and the render loop. The clean integration is to keep async agent execution outside the component tree and expose stable external-store snapshots to React, exactly as Atlas does now. OpenTUI's test renderer can deterministically capture frames and drive input, which is useful for asserting text/tool/approval/interrupt transitions independent of the model framework. [OpenTUI React binding](https://opentui.com/docs/bindings/react), [OpenTUI renderer](https://opentui.com/docs/core-concepts/renderer), [OpenTUI testing](https://opentui.com/docs/core-concepts/testing)

## Recommended spike sequence

1. **Transport only:** use a current Atlas-stored Codex access token and account ID for one `streamText` call. No tools, no refresh implementation, no persistence. Confirm status, SSE parsing, model ID, finish reason, and usage without logging secrets.
2. **Adapter boundary:** turn Vercel stream parts into Atlas's existing `EngineEvent` union. Make the provider replaceable and keep credential resolution outside it.
3. **One safe tool:** implement read-only file search and the complete `model -> tool -> model` loop. Compare manual `streamText` against `ToolLoopAgent`; prefer the manual form if Atlas needs mid-turn steering or exact event ordering.
4. **Cancellation:** map `RunningTurn.interrupt()` to `AbortController.abort()` and verify that the stream settles, tools receive the signal, partial prose is marked interrupted, and all queued persistence completes.
5. **Approval:** require approval for a write tool, persist the pending request in Atlas, and resume with an approval response. This is the decisive test of whether AI SDK's app-owned pause is comfortable enough.
6. **LangGraph comparator:** implement only the same safe tool and approval branch, with a SQLite-backed checkpointer. Measure how much state must be mirrored between graph checkpoints, Atlas repositories, and `ConversationStore`.
7. **Choose LangGraph only on evidence:** adopt it if durable workflow resume or branching materially simplifies Atlas after the comparator. Otherwise retain AI SDK Core and add explicit Atlas state transitions as needed.

## Practical architecture recommendation

Define a provider-neutral engine port and let AI SDK be one implementation:

```ts
interface HarnessTurn {
  steer(input: UserInput): boolean;
  interrupt(): Promise<void>;
  done: Promise<TurnResult>;
}

interface HarnessEngine {
  start(args: TurnArgs & { onEvent(event: EngineEvent): void }): HarnessTurn;
}
```

Behind that port:

- `CodexSubscriptionModel` owns only request/response translation for the ChatGPT Codex endpoint.
- `AiSdkHarnessEngine` owns the agent loop, tool dispatch, and `AbortController`.
- Atlas continues to own credentials, policy, approvals, event persistence, rotation, and OpenTUI-visible state.
- A future `LangGraphHarnessEngine` can implement the same port if graph durability earns its complexity.

That preserves the most valuable property of the current code: vendor and framework events are normalized before they reach the application or UI.
