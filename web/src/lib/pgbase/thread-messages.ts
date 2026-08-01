import type { LiveWhere } from '@dltech/pgbase/query';
import type { SerializedError } from '@reduxjs/toolkit';
import type { ThreadMessageView } from '@workspace/shared';
import { attachSubagentInfo, threadMessageToView } from './adapters';
import { pgbase, type Models } from './client';

/**
 * `getJobMessages`/`getThreadMessages` (`jobs.api.ts`) both need `ThreadMessage` rows joined against
 * `Subagent.status`/`endedAt` — the two fields the old server-composed feed used to deliver already
 * joined. `Subagent`'s live-readable columns are `id`/`orgId`/`status`/`endedAt` only (no `threadId`/
 * `jobId`), so unlike `getJob`'s `Job`+`ThreadGroup`+`Thread` composition (three subscriptions with a
 * `where` fixed from the start), the `Subagent` side here has no `jobId`/`threadId` column to filter
 * on — the only own-column predicate available is `id: { in: [...] }` against the subagent ids that
 * show up in the message list, and that list only grows as new messages stream in. So the `Subagent`
 * subscription's `where` is *dynamic*: every time a `ThreadMessage` delta introduces a subagent id we
 * haven't seen yet, we re-issue `subagentSub.query()` with the widened id set (a subscription's
 * `where` can be replaced by calling `query()` again — it resyncs from a fresh snapshot).
 */
function subagentIdsOf(messages: readonly Models['ThreadMessage'][]): string[] {
  return [...new Set(messages.flatMap((m) => (m.subagentId ? [m.subagentId] : [])))];
}

function mergeWithSubagents(
  messages: readonly Models['ThreadMessage'][],
  subagentsById: ReadonlyMap<string, Models['Subagent']>,
): ThreadMessageView[] {
  return messages.map((m) => {
    const view = threadMessageToView(m);
    return m.subagentId ? attachSubagentInfo(view, subagentsById.get(m.subagentId)) : view;
  });
}

interface ThreadMessagesState {
  readonly messageSub: ReturnType<typeof pgbase.ThreadMessage.createSubscription>;
  readonly subagentSub: ReturnType<typeof pgbase.Subagent.createSubscription>;
  readonly knownSubagentIds: Set<string>;
}

/** Shared `queryFn`/`onCacheEntryAdded` pair for both `ThreadMessage` feeds in `jobs.api.ts`. */
export function liveThreadMessagesEndpoint<Arg>(where: (arg: Arg) => LiveWhere): {
  queryFn: (
    arg: Arg,
  ) => Promise<{ data: ThreadMessageView[]; meta: ThreadMessagesState } | { error: SerializedError }>;
  onCacheEntryAdded: (
    arg: Arg,
    api: {
      readonly cacheDataLoaded: PromiseLike<{ readonly meta?: unknown }>;
      readonly cacheEntryRemoved: PromiseLike<void>;
      updateCachedData(recipe: () => ThreadMessageView[]): unknown;
    },
  ) => Promise<void>;
} {
  return {
    async queryFn(arg) {
      const messageSub = pgbase.ThreadMessage.createSubscription();
      const subagentSub = pgbase.Subagent.createSubscription();
      try {
        const messages = await messageSub.query({ where: where(arg) });
        const ids = subagentIdsOf(messages);
        const subagents = ids.length > 0 ? await subagentSub.query({ where: { id: { in: ids } } }) : [];
        const byId = new Map(subagents.map((s) => [s.id, s] as const));
        return {
          data: mergeWithSubagents(messages, byId),
          meta: { messageSub, subagentSub, knownSubagentIds: new Set(ids) },
        };
      } catch (err) {
        messageSub.close();
        subagentSub.close();
        return { error: { message: err instanceof Error ? err.message : String(err) } };
      }
    },

    async onCacheEntryAdded(_arg, api) {
      const { meta } = await api.cacheDataLoaded;
      const state = meta as ThreadMessagesState | undefined;
      if (!state) return;

      let messages = state.messageSub.getSnapshot();
      let subagentsById = new Map(state.subagentSub.getSnapshot().map((s) => [s.id, s] as const));
      const recompute = () => api.updateCachedData(() => mergeWithSubagents(messages, subagentsById));

      const widenSubagentSubscription = () => {
        let grew = false;
        for (const id of subagentIdsOf(messages)) {
          if (!state.knownSubagentIds.has(id)) {
            state.knownSubagentIds.add(id);
            grew = true;
          }
        }
        if (grew) {
          void state.subagentSub
            .query({ where: { id: { in: [...state.knownSubagentIds] } } })
            .catch(() => {});
        }
      };

      const offMessages = state.messageSub.subscribe((rows) => {
        messages = rows;
        widenSubagentSubscription();
        recompute();
      });
      const offSubagents = state.subagentSub.subscribe((rows) => {
        subagentsById = new Map(rows.map((s) => [s.id, s] as const));
        recompute();
      });

      await api.cacheEntryRemoved;
      offMessages();
      offSubagents();
      state.messageSub.close();
      state.subagentSub.close();
    },
  };
}
