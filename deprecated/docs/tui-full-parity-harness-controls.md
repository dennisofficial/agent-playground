# AI SDK v7 controls for a Claude Code-parity harness

Research date: 2026-08-24. The installed package inspected alongside the official documentation is `ai@7.0.77`.

## Conclusion

AI SDK Core is low-level enough to be the **model and tool protocol layer**, but `ToolLoopAgent` should not own a full Claude Code-parity loop. Use `streamText()` one model step at a time and keep the transcript, event log, approvals, workspace snapshots, retry policy, and scheduling in Atlas.

AI SDK has good interception and HITL building blocks. It does **not** provide semantic checkpoints, replay/fork, or rollback of tool side effects. LangGraph has structurally stronger primitives for those concerns. The strongest composition is therefore:

> Atlas/OpenTUI owns product state and workspace snapshots; a thin LangGraph graph owns resumable control flow; AI SDK Core inside the model node owns provider/model streaming and typed tool protocol.

This is not an either/or dependency choice. LangGraph nodes can call AI SDK Core.

## Capability matrix

| Requirement | AI SDK v7 | Consequence for Atlas |
| --- | --- | --- |
| Manual loop | Yes. Vercel explicitly documents a loop around `generateText()`/`streamText()` for complete control. | Prefer a one-step call controlled by Atlas over an opaque multi-step `ToolLoopAgent`. |
| Built-in loop | `ToolLoopAgent`, `stopWhen`, and `prepareStep` provide a convenient ReAct loop. The loop stops on a final response, a tool without `execute`, an approval request, or a stop condition. | Useful for small agents; too much implicit ownership for parity work. |
| Rewind/replay/fork | No Core primitive. UI `regenerate({ messageId })` regenerates/replaces a message; it is not state-machine replay and does not undo tool side effects. | Persist an append-only run/event log and snapshot the git/worktree/filesystem separately. |
| Pre-tool interception | Strongest path: define tools without `execute`, receive validated calls, make policy decisions, then inject results. `toolApproval`/`needsApproval` can also approve, deny, or request a user decision from parsed input. | Put permissions, sandbox selection, and side-effect policy in Atlas's dispatcher before execution. |
| Tool input modification | `experimental_refineToolInput` runs after parsing/validation and before execution, emitted parts, callbacks, and telemetry. | Available, but experimental. For auditability, prefer an explicit dispatcher that records original and effective input. |
| Pre-execution callback | `onToolExecutionStart` runs immediately before `execute`; `onToolExecutionEnd` reports success/error. The start callback returns only `void`, and current source deliberately swallows callback errors. | Treat lifecycle callbacks as telemetry, never as a security or permission gate. |
| Tool input lifecycle | Tools expose `onInputStart`, `onInputDelta`, and `onInputAvailable`; the first two are streaming-only. | Enough to display a pending command while Claude is still forming its arguments. |
| HITL approval | `needsApproval` or `toolApproval` emits a `tool-approval-request` and ends the call. Persist it, append a `tool-approval-response`, then make a new call. Dynamic policy can inspect typed input and runtime/tool context. | This is naturally process-resumable **only if Atlas persists the messages and pending approval**. Core itself is not a checkpointer. |
| Approval editing | Built-in response is approve/deny plus optional reason; it is not a first-class “edit arguments and resume” operation. | Model edits explicitly in Atlas (new effective tool call/result) or use LangGraph's interrupt/update flow. |
| Approval integrity | `experimental_toolApprovalSecret` HMAC-signs requests and verifies replayed approvals. | Useful if approvals cross a client/server trust boundary; still experimental. |
| Arbitrary human input | A tool without `execute` can stop the loop; external code supplies a typed result and continues. AI SDK UI exposes `addToolOutput`. | Good fit for `AskUserQuestion`, plan confirmation, and permission prompts. |
| Tool result injection | Omit `execute`, then append the matching tool-result message (or use UI's `addToolOutput`). `toModelOutput` controls what the model receives from an executed tool. | Atlas can retain rich internal results while sending a compact/redacted representation to the model. |
| Abort | Calls accept `AbortSignal`; tools receive it; streaming exposes `onAbort` with completed steps and emits an abort part. | Implement Esc/Ctrl-C with an `AbortController`, then persist the partial transcript deliberately. |
| Mid-turn steering | No primitive mutates a provider request already in flight. `prepareStep` can alter messages/model/tools only at the next model-step boundary. | For true steering, abort the active model call, preserve the accepted partial output as policy dictates, append steering input, and start a new step. Alternatively queue steering until the boundary. |
| Per-step control | `prepareStep` can replace model, messages, instructions, tool choice, active tools, provider options, and runtime context between steps. | Useful if retaining `ToolLoopAgent`; a manual loop makes the transition more explicit and persistable. |
| Model/provider interception | `wrapLanguageModel` middleware supports `transformParams`, `wrapGenerate`, and `wrapStream`; `customProvider` and provider registries support aliases, fallbacks, and wrapped models. | Sufficient for subscription OAuth adapters, provider-specific request shaping, logging, caching, and redaction. |
| Durable execution | Core message persistence and resumable UI streams are application-owned. `@ai-sdk/workflow` adds a durable `WorkflowAgent`, but it is a separate workflow runtime rather than rewind/time-travel in Core. | Do not confuse reconnecting to an active stream with replaying agent state or reverting the workspace. |

## What “rewind” must mean

A coding harness has at least three independent timelines:

1. **Conversation state** — model messages, reasoning/tool events, approvals.
2. **Control state** — current node, pending tool, retry counters, interrupt reason.
3. **World state** — files, git index/worktree, subprocesses, external APIs.

AI SDK lets Atlas reconstruct the first by supplying an earlier message list. It does not checkpoint the second or roll back the third. LangGraph checkpoints cover graph/control state and enable replay/fork, but even LangGraph cannot undo arbitrary shell commands or external effects. Claude Code-parity rewind therefore still requires a workspace snapshot/restore design and idempotency metadata for non-filesystem tools.

## Why LangGraph is structurally stronger for rewind and HITL

LangGraph persists a state snapshot at each super-step. Its documented APIs expose state history, replay from a prior checkpoint, fork by updating historical state, and `interrupt()`/`Command({ resume })` for process-independent HITL. The human-in-the-loop layer supports accept, edit, and respond decisions. These are runtime concepts, not conventions built from message arrays.

The tradeoff is another state model. Atlas should keep the graph state deliberately small—run ID, transcript cursor, pending action, checkpoint/snapshot IDs—and leave canonical conversation data in its existing repositories. Avoid mirroring the entire `ConversationStore` inside graph state.

## Recommended parity architecture

See the concrete TypeScript reference in [full-parity-harness.ts](./examples/full-parity-harness.ts). It keeps tool execution outside AI SDK, places the human interrupt before side effects, records snapshot IDs, and uses idempotency keys for replay safety.

```text
OpenTUI
  -> Atlas application services / event log
      -> LangGraph functional graph (control checkpoints + interrupts)
          -> model step: AI SDK streamText(stop after one step)
          -> policy step: inspect/approve/edit/deny tool call
          -> tool step: Atlas sandboxed dispatcher
          -> snapshot step: git/workspace checkpoint metadata
```

Do not use `onToolExecutionStart` as the permission boundary. Either omit `execute` entirely and dispatch tools yourself, or use a real `toolApproval` gate. The manual-dispatch design offers the most deterministic audit trail and makes pre-tool hooks, edited inputs, cancellation, and replay explicit.

## Primary sources

- Vercel, [Agents: Loop Control](https://ai-sdk.dev/docs/agents/loop-control) — built-in and manual loops, `stopWhen`, and `prepareStep`.
- Vercel, [AI SDK Core: Tool Calling](https://ai-sdk.dev/docs/ai-sdk-core/tools-and-tool-calling) — optional execution, approvals, lifecycle hooks, errors, and response messages.
- Vercel, [`tool()` reference](https://ai-sdk.dev/docs/reference/ai-sdk-core/tool) — `needsApproval`, execution context, streamed-input callbacks, and `toModelOutput`.
- Vercel, [`streamText()` reference](https://ai-sdk.dev/docs/reference/ai-sdk-core/stream-text) — abort, callbacks, per-step control, and stream parts.
- Vercel, [manual agent loop cookbook](https://ai-sdk.dev/cookbook/node/manual-agent-loop) — application-owned loop and message history.
- Vercel, [AI SDK UI tool usage](https://ai-sdk.dev/docs/ai-sdk-ui/chatbot-tool-usage) — external tool output injection and resubmission.
- Vercel, [stopping streams](https://ai-sdk.dev/docs/advanced/stopping-streams) and [resuming streams](https://ai-sdk.dev/docs/ai-sdk-ui/chatbot-resume-streams) — abort/reconnect semantics and application-owned persistence.
- Vercel, [language-model middleware](https://ai-sdk.dev/docs/ai-sdk-core/middleware) and [`customProvider`](https://ai-sdk.dev/docs/reference/ai-sdk-core/custom-provider) — provider interception and composition.
- Vercel source, [`execute-tool-call.ts`](https://github.com/vercel/ai/blob/main/packages/ai/src/generate-text/execute-tool-call.ts) and [`notify.ts`](https://github.com/vercel/ai/blob/main/packages/ai/src/util/notify.ts) — callback placement and swallowed callback errors.
- Vercel source, [`@ai-sdk/workflow` README](https://github.com/vercel/ai/tree/main/packages/workflow) — durable `WorkflowAgent` scope.
- LangChain, [LangGraph persistence](https://docs.langchain.com/oss/javascript/langgraph/persistence), [time travel](https://docs.langchain.com/oss/javascript/langgraph/use-time-travel), and [interrupts](https://docs.langchain.com/oss/javascript/langgraph/interrupts) — native checkpoint, replay/fork, and durable HITL semantics.
- LangChain, [human-in-the-loop](https://docs.langchain.com/oss/javascript/langchain/human-in-the-loop) — accept/edit/respond decisions backed by checkpoints.
