import type {
  NonNullableUsage,
  SDKMessage,
} from "@anthropic-ai/claude-agent-sdk";
import { Injectable } from "@nestjs/common";
import type { EngineEvent, TurnUsage } from "../../domain/message.js";
import { summariseToolResult, toolTarget } from "../../domain/tool-summary.js";
import { taskEvents } from "./task-frames.js";
import {
  resolveContextLimit,
  toPercent,
  windowKeyFor,
} from "../../domain/usage.js";

export type NormaliseContext = {
  cwd: string;
  tools: Map<string, { name: string; input: unknown }>;
};

export function createNormaliseContext(cwd: string): NormaliseContext {
  return { cwd, tools: new Map() };
}

@Injectable()
export class ClaudeNormaliserService {
  /** One SDK message can carry several domain events — an assistant frame is often text + tool_use. */
  normalise(message: SDKMessage, context: NormaliseContext): EngineEvent[] {
    switch (message.type) {
      case "system":
        return this.system(message);
      case "stream_event":
        return this.streamEvent(message);
      case "assistant":
        return this.assistant(message, context);
      case "user":
        return this.user(message, context);
      case "rate_limit_event":
        return this.rateLimit(message);
      case "result":
        return this.result(message);
      default:
        // Unknown/uninteresting frames are dropped from the domain stream but still hit the raw
        // tape, which is the whole reason the tape exists.
        return [];
    }
  }

  private system(
    message: Extract<SDKMessage, { type: "system" }>,
  ): EngineEvent[] {
    if (message.subtype === "init") {
      return [
        {
          kind: "session",
          engineSessionId: message.session_id,
          model: message.model,
        },
      ];
    }
    if (message.subtype === "api_retry") {
      const seconds = Math.round(message.retry_delay_ms / 1000);
      return [
        {
          kind: "error",
          title:
            `API Error: ${message.error_status ?? ""} ${message.error}`.trim(),
          detail: `Retrying ${message.attempt}/${message.max_retries} in ${seconds}s…`,
          retryable: false,
        },
      ];
    }
    return taskEvents(message);
  }

  /** Deltas are a live view of a block being built. They render and persist NOTHING. */
  private streamEvent(
    message: Extract<SDKMessage, { type: "stream_event" }>,
  ): EngineEvent[] {
    // A DELEGATE's deltas would stream into this thread's tail — its prose appearing as the parent's,
    // mid-sentence. Not currently forwarded (`forwardSubagentText` is off), so this guard is what makes
    // turning that flag on a rendering decision rather than a regression.
    if (message.parent_tool_use_id) return [];
    const event = message.event as {
      type?: string;
      delta?: { type?: string; text?: string; thinking?: string };
    };
    if (event?.type !== "content_block_delta") return [];
    const delta = event.delta;
    if (delta?.type === "text_delta" && delta.text) {
      return [{ kind: "text_delta", text: delta.text }];
    }
    if (delta?.type === "thinking_delta" && delta.thinking) {
      return [{ kind: "thinking_delta", text: delta.thinking }];
    }
    return [];
  }

  /** The authoritative blocks. These are the truth; deltas were only the view. */
  private assistant(
    message: Extract<SDKMessage, { type: "assistant" }>,
    context: NormaliseContext,
  ): EngineEvent[] {
    const events: EngineEvent[] = [];
    const inner = message.message;

    // Set on every frame a SUBAGENT produces. A subagent has its own context window, so its usage
    // is a different measurement that happens to arrive on the same stream.
    const parentToolUseId = message.parent_tool_use_id ?? undefined;

    const usage = inner.usage;
    if (usage) {
      // Context pressure is input + both cache halves — what the next request will actually resend.
      const contextTokens =
        (usage.input_tokens ?? 0) +
        (usage.cache_read_input_tokens ?? 0) +
        (usage.cache_creation_input_tokens ?? 0);
      // A turn ends with `<synthetic>` frames whose usage is all zeroes. They are not a reading of
      // an empty context — emitting one stomped the meter to `ctx 0%` at the end of every turn.
      if (contextTokens > 0) {
        events.push({
          kind: "usage",
          contextTokens,
          contextLimit: resolveContextLimit(inner.model),
          ...(parentToolUseId === undefined ? {} : { parentToolUseId }),
        });
      }
    }

    for (const block of inner.content as ContentBlock[]) {
      // Prose carries the tag for the same reason a call does. `forwardSubagentText` being off is not
      // the guarantee it reads like: a subagent's SUMMARIZED thinking arrives regardless, and untagged
      // it was persisted as the parent's own reasoning — five of a delegate's thoughts in a row, in a
      // thread that had made one.
      if (block.type === "text" && block.text) {
        events.push({
          kind: "text",
          text: block.text,
          ...(parentToolUseId === undefined ? {} : { parentToolUseId }),
        });
      } else if (block.type === "thinking" && block.thinking) {
        events.push({
          kind: "thinking",
          text: block.thinking,
          ...(parentToolUseId === undefined ? {} : { parentToolUseId }),
        });
      } else if (block.type === "tool_use" && block.name) {
        const toolUseId = block.id ?? "";
        context.tools.set(toolUseId, { name: block.name, input: block.input });
        const target = toolTarget(block.name, block.input, context.cwd);
        events.push({
          kind: "tool_call",
          toolUseId,
          name: block.name,
          ...(target === undefined ? {} : { target }),
          input: block.input,
          // Carried through, and it is what keeps a DELEGATE's calls out of this thread's transcript.
          // Without `forwardSubagentText` these tool blocks are the only thing a subagent forwards, so
          // they were the entire visible symptom: a delegate's fifteen greps, persisted as the
          // parent's own.
          ...(parentToolUseId === undefined ? {} : { parentToolUseId }),
        });
      }
    }
    return events;
  }

  /** Tool results come back on a `user` frame — that is the SDK's loop, not a real user turn. */
  private user(
    message: Extract<SDKMessage, { type: "user" }>,
    context: NormaliseContext,
  ): EngineEvent[] {
    const content = message.message?.content;
    if (!Array.isArray(content)) return [];

    // Same rule as the assistant frame: a result addressed to a DELEGATE's call is the delegate's, and
    // is tagged so nothing downstream mistakes it for this thread's.
    const parentToolUseId = message.parent_tool_use_id ?? undefined;
    const events: EngineEvent[] = [];
    for (const block of content as ContentBlock[]) {
      if (block.type !== "tool_result") continue;
      const toolUseId = block.tool_use_id ?? "";
      const call = context.tools.get(toolUseId);
      const ok = block.is_error !== true;
      const lines = flattenResult(block.content);
      // The frame carries a second, richer account of the tool run beside the model-facing text —
      // for an edit, the structured patch. It sits on the FRAME, not in the content block, which is
      // why it is read here rather than off `block`.
      const { summary, detail, diff } = summariseToolResult({
        name: call?.name ?? "Tool",
        input: call?.input,
        lines,
        ok,
        raw: message.tool_use_result,
      });
      events.push({
        kind: "tool_result",
        toolUseId,
        ok,
        summary,
        detail,
        ...(diff === undefined ? {} : { diff }),
        ...(parentToolUseId === undefined ? {} : { parentToolUseId }),
      });
    }
    return events;
  }

  /**
   * One frame, up to two facts: how full a subscription window is, and whether this turn is being
   * billed to credits. They were one before extra usage existed, and conflating them meant a spent
   * WALLET (`rateLimitType: 'overage'`) fell through the `?? 'fiveHour'` fallback and was written
   * down as a spent five-hour window — sending rotation to look for headroom that was never gone.
   */
  private rateLimit(
    message: Extract<SDKMessage, { type: "rate_limit_event" }>,
  ): EngineEvent[] {
    const info = message.rate_limit_info;
    const events: EngineEvent[] = [];

    // The wallet is what was refused, rather than a window: the turn is over money.
    const walletRefused =
      info.rateLimitType === "overage" && info.status === "rejected";
    // `overageStatus: 'rejected'` alone is NOT news — it rides ordinary allowed frames on every
    // account that has no credits configured (see `rateLimitWithoutUtilisation`, taken from a real
    // tape), and reporting it would tell every user on every turn about a feature they never asked
    // for. Only a stated reason, a refusal of the wallet itself, or the wallet actually being in use.
    const disabledReason =
      info.overageDisabledReason ??
      (walletRefused ? (info.errorCode ?? "out_of_credits") : undefined);
    const inUse = info.isUsingOverage === true || info.overageInUse === true;
    if (inUse || disabledReason !== undefined) {
      events.push({
        kind: "extra_usage",
        inUse,
        ...(info.rateLimitType === "overage" && info.utilization !== undefined
          ? { utilization: toPercent(info.utilization) ?? 100 }
          : {}),
        ...(disabledReason === undefined ? {} : { disabledReason }),
      });
    }

    // `rejected` on a WINDOW means that window is full; `rejected` on the wallet says nothing about
    // any window, so it must not be allowed to write 100 into one.
    const rejected = info.status === "rejected" && !walletRefused;
    const window =
      windowKeyFor(info.rateLimitType) ?? (rejected ? "fiveHour" : null);
    const utilization = rejected ? 100 : toPercent(info.utilization);
    if (!window || utilization === null) return events;
    const resetsAt = epochToIso(info.resetsAt);
    events.push({
      kind: "rate_limit",
      window,
      utilization,
      ...(resetsAt === null ? {} : { resetsAt }),
    });
    return events;
  }

  private result(
    message: Extract<SDKMessage, { type: "result" }>,
  ): EngineEvent[] {
    const usage = this.turnUsage(message);
    // Emitted BEFORE the result, so a listener that treats `result` as the end of the turn has
    // already seen it. Only when the server said something: `undefined` is an ordinary turn on a
    // model that has no opinion about speed, not a fast mode that failed.
    const fastMode: EngineEvent[] =
      message.fast_mode_state === undefined
        ? []
        : [
            {
              kind: "fast_mode",
              state: message.fast_mode_state,
              ...(message.fast_mode_disabled_reason === undefined
                ? {}
                : { disabledReason: message.fast_mode_disabled_reason }),
            },
          ];
    if (message.subtype === "success") {
      return [
        ...fastMode,
        { kind: "result", ok: !message.is_error, text: message.result, usage },
      ];
    }
    return [
      ...fastMode,
      {
        kind: "error",
        title: `Turn ended: ${message.subtype}`,
        retryable: true,
      },
      { kind: "result", ok: false, usage },
    ];
  }

  private turnUsage(
    message: Extract<SDKMessage, { type: "result" }>,
  ): TurnUsage | undefined {
    const usage = message.usage as Partial<NonNullableUsage> | undefined;
    if (!usage) return undefined;

    // `modelUsage` is keyed by model and normally holds exactly one entry; a turn that fell back
    // mid-flight holds two. The heaviest is the one worth naming.
    const models = Object.entries(message.modelUsage ?? {});
    const busiest = models.sort(
      (a, b) => b[1].outputTokens - a[1].outputTokens,
    )[0];

    return {
      inputTokens: usage.input_tokens ?? 0,
      outputTokens: usage.output_tokens ?? 0,
      cacheReadTokens: usage.cache_read_input_tokens ?? 0,
      cacheWriteTokens: usage.cache_creation_input_tokens ?? 0,
      // Subscription turns report 0 rather than a cost; a zero here means "not billed", and
      // storing it as such beats storing `$0.00` as though it had been priced.
      ...(message.total_cost_usd ? { costUsd: message.total_cost_usd } : {}),
      ...(busiest ? { model: busiest[0] } : {}),
    };
  }
}

type ContentBlock = {
  type: string;
  id?: string;
  text?: string;
  name?: string;
  input?: unknown;
  thinking?: string;
  tool_use_id?: string;
  content?: unknown;
  is_error?: boolean;
};

/** Tool result content is a string or a block array; the renderer only ever wants lines. */
export function flattenResult(content: unknown): string[] {
  if (content == null) return [];
  if (typeof content === "string") return content.split("\n");
  if (Array.isArray(content)) {
    return content
      .flatMap((block) => {
        if (typeof block === "string") return block.split("\n");
        const text = (block as { text?: unknown }).text;
        return typeof text === "string" ? text.split("\n") : [];
      })
      .filter((line) => line !== undefined);
  }
  return [];
}

/** The SDK sends seconds or milliseconds depending on the field; normalise both. */
function epochToIso(resetsAt: number | undefined): string | null {
  if (resetsAt == null) return null;
  const ms = resetsAt < 1e12 ? resetsAt * 1000 : resetsAt;
  const date = new Date(ms);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}
