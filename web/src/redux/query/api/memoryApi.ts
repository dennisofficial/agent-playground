'use client';

import { baseApi, EBaseApiCacheTags } from '@/redux/query/api/baseApi';
import { listAllFacts } from '@/lib/admin-api';
import type { TenantView, FactView } from '@workspace/shared';

export const memoryApi = baseApi.injectEndpoints({
  endpoints: (builder) => ({
    getTenants: builder.query<TenantView[], void>({
      query: () => ({
        url: '/tenants',
      }),
      providesTags: [{ type: EBaseApiCacheTags.TENANT, id: 'LIST' }],
    }),
    getAllFacts: builder.query<
      { facts: FactView[]; total: number; truncated: boolean },
      { teamId: string }
    >({
      queryFn: async ({ teamId }) => {
        try {
          const result = await listAllFacts(teamId);
          return { data: result };
        } catch (error: any) {
          return {
            error: {
              status: error?.response?.status ?? -1,
              message: error?.message ?? 'Failed to load facts',
              error: error?.name ?? 'Error',
            },
          };
        }
      },
      providesTags: (_result, _error, { teamId }) => [
        { type: EBaseApiCacheTags.FACT, id: teamId },
      ],
    }),
  }),
  overrideExisting: true,
});

export const { useGetTenantsQuery, useGetAllFactsQuery } = memoryApi;
