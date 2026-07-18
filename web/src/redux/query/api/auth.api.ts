import { env } from '@/lib/env';
import type { CurrentUserResponse, OrgSummary } from '@workspace/shared';
import { baseApi, EBaseApiCacheTags } from './baseApi';
import { sseOpener } from './sse-opener';

export const authApi = baseApi.injectEndpoints({
  overrideExisting: true,
  endpoints: (build) => ({
    getSession: build.query<CurrentUserResponse, void>({
      query: () => ({ url: '/auth/session', method: 'GET' }),
      providesTags: [EBaseApiCacheTags.SESSION],
      onCacheEntryAdded: async (_arg, api) => {
        const controller = new AbortController();
        try {
          await api.cacheDataLoaded;
          const stream = sseOpener(
            new URL('orgs/realtime', env.NEXT_PUBLIC_BACKEND_URL).toString(),
            {
              signal: controller.signal,
              onmessage: (ev) => {
                if (ev.event !== 'data' || !ev.data) return;
                const rows = JSON.parse(ev.data) as Array<{
                  pk: string;
                  row: OrgSummary;
                }>;
                api.updateCachedData((draft) => {
                  draft.orgs = rows.map((r) => r.row);
                });
              },
            },
          );
          await api.cacheEntryRemoved;
          controller.abort();
          await stream.catch(() => undefined);
        } catch {
          controller.abort();
        }
      },
    }),
  }),
});

export const { useGetSessionQuery } = authApi;
