import type {
  LiveArgs,
  LiveQueryMeta,
  ModelAccessor,
  RtkCacheLifecycleApi,
} from '@dltech/pgbase/client';
import type { SerializedError } from '@reduxjs/toolkit';

function toSerializedError(err: unknown): SerializedError {
  return { message: err instanceof Error ? err.message : String(err) };
}

/**
 * Like `@dltech/pgbase/client`'s `liveQueryEndpoint`, but maps each row through `mapRow` — needed
 * everywhere a `Models['X']` live row has to land in an RTK Query cache typed as the pre-existing
 * `@workspace/shared` view DTO (`RepoView`, `JobListItem`, …) rather than the raw pgbase row. The
 * upstream helper has no transform hook (`transformResponse` isn't invoked for `queryFn`-based
 * endpoints), so this is a one-line-changed copy of its implementation.
 *
 * The error shape is `SerializedError`, not the plain `string` `liveQueryEndpoint` uses upstream —
 * `baseApi` (`redux/query/api/baseApi.ts`) is built on `axiosQuery`, whose error type is
 * `NormalizedError | SerializedError`, not `string` (the pgbase example app's own `liveApi` uses
 * `fakeBaseQuery<string>()` specifically so the plain-string shape type-checks; atlas's single shared
 * `baseApi` needs its own error type honored instead).
 */
export function liveListEndpoint<T, V, Arg = void>(
  accessor: ModelAccessor<T>,
  mapRow: (row: T) => V,
  toArgs: (arg: Arg) => LiveArgs = () => ({}),
): {
  queryFn: (
    arg: Arg,
  ) => Promise<{ data: V[]; meta: LiveQueryMeta<T> } | { error: SerializedError }>;
  onCacheEntryAdded: (arg: Arg, api: RtkCacheLifecycleApi<V>) => Promise<void>;
} {
  return {
    async queryFn(arg) {
      const subscription = accessor.createSubscription();
      try {
        const rows = await subscription.query(toArgs(arg));
        return { data: rows.map(mapRow), meta: { subscription } };
      } catch (err) {
        subscription.close();
        return { error: toSerializedError(err) };
      }
    },

    async onCacheEntryAdded(_arg, api) {
      const { meta } = await api.cacheDataLoaded;
      const subscription = (meta as LiveQueryMeta<T> | undefined)?.subscription;
      if (!subscription) return;
      const off = subscription.subscribe((rows) => api.updateCachedData(() => rows.map(mapRow)));
      await api.cacheEntryRemoved;
      off();
      subscription.close();
    },
  };
}
