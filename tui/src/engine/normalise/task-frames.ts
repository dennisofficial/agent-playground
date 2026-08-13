import type { SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import {
  EDelegateStatus,
  type DelegateEvent,
  type DelegateOutcome,
} from "../../domain/delegate-events.js";

/**
 * The SDK's delegate bookkeeping → the domain's.
 *
 * Five `system` subtypes that together are the only account of a delegated run's LIFECYCLE. A
 * delegate's own output arrives elsewhere, tagged with `parent_tool_use_id`, and says nothing about
 * whether the run is still going — which is why a harness that reads only the tagged frames can count
 * a subagent's work and still have no idea it has finished.
 *
 * Split out of the normaliser service because it is a self-contained table with no shared state: the
 * service's other branches all thread `NormaliseContext` through, and these thread nothing.
 *
 * `task_updated` is deliberately not read. Its only unique claim — a foreground task being
 * backgrounded — is also carried by `background_tasks_changed`, which is a level rather than a patch
 * and therefore cannot desynchronise.
 */
export function taskEvents(
  message: Extract<SDKMessage, { type: "system" }>,
): DelegateEvent[] {
  if (message.subtype === "task_started") {
    // `skip_transcript` marks an ambient housekeeping task the SDK asks consumers to keep out of the
    // inline transcript. Atlas drops it outright: it has one delegate surface, and nothing here is
    // worth a row that the SDK itself calls noise.
    if (message.skip_transcript) return [];
    return [
      {
        kind: "task_started",
        taskId: message.task_id,
        ...(message.tool_use_id === undefined
          ? {}
          : { parentToolUseId: message.tool_use_id }),
        description: message.description,
        ...(message.subagent_type === undefined
          ? {}
          : { agentType: message.subagent_type }),
        ...(message.task_type === undefined
          ? {}
          : { taskType: message.task_type }),
        // Not knowable from this frame — a Task run in the background looks identical here. The
        // `background_tasks_changed` LEVEL is the authority, and normally precedes this bookend.
        background: false,
      },
    ];
  }

  if (message.subtype === "task_progress") {
    return [
      {
        kind: "task_progress",
        taskId: message.task_id,
        ...(message.tool_use_id === undefined
          ? {}
          : { parentToolUseId: message.tool_use_id }),
        toolUses: message.usage.tool_uses,
        durationMs: message.usage.duration_ms,
        ...(message.last_tool_name === undefined
          ? {}
          : { lastTool: message.last_tool_name }),
        ...(message.summary === undefined ? {} : { summary: message.summary }),
      },
    ];
  }

  if (message.subtype === "task_notification") {
    if (message.skip_transcript) return [];
    return [
      {
        kind: "task_settled",
        taskId: message.task_id,
        ...(message.tool_use_id === undefined
          ? {}
          : { parentToolUseId: message.tool_use_id }),
        status: outcomeOf(message.status),
        ...(message.summary === undefined ? {} : { summary: message.summary }),
      },
    ];
  }

  if (message.subtype === "background_tasks_changed") {
    return [
      {
        kind: "background_tasks",
        tasks: message.tasks.map((task) => ({
          taskId: task.task_id,
          taskType: task.task_type,
          description: task.description,
        })),
      },
    ];
  }

  return [];
}

/**
 * The SDK's three terminal words → the domain's. Widened at the boundary rather than cast: `status` is
 * a string union on the wire, and a fourth member arriving should read as `stopped` — an unrecognised
 * ending is still an ending, and a delegate row that never settles spins forever.
 */
function outcomeOf(status: string): DelegateOutcome {
  if (status === "completed") return EDelegateStatus.completed;
  if (status === "failed") return EDelegateStatus.failed;
  return EDelegateStatus.stopped;
}
