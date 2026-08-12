import { EMessageType } from '../generated/prisma/enums.js';
import { attachmentExpandKey } from './attachments.js';
import type { Message, ToolResultPayload } from './message.js';

/**
 * The two lookups a transcript needs over its own messages: what can be opened, and what a tool call
 * resolved to.
 *
 * Pure and here rather than inline in the page because the first one is a RULE, not a loop — two
 * kinds of thing expand under one set, and the key a chip is stored under has to be the key the
 * block reads. Get that wrong and the chip draws collapsed and stays collapsed forever, which is a
 * silent failure a mounted page cannot fail on and a table test catches immediately.
 */

/**
 * Everything `x` / `X` can open, in the order it was said.
 *
 * Message order is load-bearing: `x` opens the LAST id, and "the last thing that appeared" is what
 * a reader means by it. A tool call is keyed by its `toolUseId`; a seam message's attachments are
 * keyed by `attachmentExpandKey`, namespaced so the two can share one set without colliding.
 *
 * Per MESSAGE rather than per chip — a hand-off's files are one thing you either wanted to read or
 * did not, and four keypresses to open four attachments of one message is not a feature.
 */
export function expandableIds(messages: readonly Message[]): string[] {
  const ids: string[] = [];
  for (const message of messages) {
    const { payload } = message;
    if (payload.type === EMessageType.tool_call) {
      ids.push(payload.toolUseId);
      continue;
    }
    // Nothing to open where nothing was attached: an id here would be a keypress that appears to do
    // nothing, and `X`'s all-expanded test would count a message that can never be expanded.
    if (
      payload.type === EMessageType.harness &&
      payload.attachments &&
      payload.attachments.length > 0
    ) {
      ids.push(attachmentExpandKey(message.id));
    }
  }
  return ids;
}

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
