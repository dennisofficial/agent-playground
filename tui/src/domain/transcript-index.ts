import { EMessageType } from '../generated/prisma/enums.js';
import type { Message, ToolResultPayload } from './message.js';

/**
 * The two lookups a transcript needs over its own messages: what each tool call resolved to, and which
 * calls have not resolved yet.
 *
 * There used to be a third — `expandableIds`, an ordered list of every key `x` / `X` could reach. It is
 * gone with those bindings, which could never have fired: the composer takes first refusal on every key
 * and consumes printable characters. Expansion is the pointer's job now, and a pointer needs no index.
 */

/** `toolUseId` → its result, so a tool call can draw what it returned inline beneath itself. */
export function toolResultsById(
  messages: readonly Message[],
): Map<string, ToolResultPayload> {
  const results = new Map<string, ToolResultPayload>();
  for (const message of messages) {
    if (message.payload.type === EMessageType.tool_result) {
      results.set(message.payload.toolUseId, message.payload);
    }
  }
  return results;
}

/**
 * The calls with no result yet — the ones a group draws with a spinner.
 *
 * Derived from the messages rather than read off `runningTool`, because a turn can have SEVERAL calls
 * in flight at once (one assistant frame may carry a batch) and `runningTool` holds one. Bounded to a
 * running turn by the caller: outside one, a call with no result is a call whose result never came,
 * and spinning forever over a dead turn would be a lie.
 */
export function inFlightToolIds(messages: readonly Message[]): Set<string> {
  const answered = new Set<string>();
  const called: string[] = [];
  for (const message of messages) {
    const { payload } = message;
    if (payload.type === EMessageType.tool_result) answered.add(payload.toolUseId);
    else if (payload.type === EMessageType.tool_call) called.push(payload.toolUseId);
  }
  return new Set(called.filter((id) => !answered.has(id)));
}
