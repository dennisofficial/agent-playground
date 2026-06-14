'use client';

import { baseApi, EBaseApiCacheTags } from '@/redux/query/api/baseApi';
import type { GithubTokenMeta } from '@/lib/admin-api';

const type = EBaseApiCacheTags.TOKEN;

const tenantBase = (teamId: string) => `/tenants/${encodeURIComponent(teamId)}`;

export const tokenApi = baseApi.injectEndpoints({
  endpoints: (builder) => ({
    getTokens: builder.query<GithubTokenMeta[], string>({
      query: (teamId) => ({
        url: `${tenantBase(teamId)}/tokens`,
      }),
      providesTags: (result) =>
        result
          ? [{ type, id: 'LIST' }, ...result.map(({ name }) => ({ type, id: name }))]
          : [{ type, id: 'LIST' }],
    }),
    putToken: builder.mutation<
      GithubTokenMeta,
      { teamId: string; dto: { name: string; token: string; default?: boolean } }
    >({
      query: ({ teamId, dto }) => ({
        url: `${tenantBase(teamId)}/tokens`,
        method: 'POST',
        data: dto,
      }),
      invalidatesTags: [{ type, id: 'LIST' }],
    }),
    setDefaultToken: builder.mutation<{ ok: boolean }, { teamId: string; name: string }>({
      query: ({ teamId, name }) => ({
        url: `${tenantBase(teamId)}/tokens/${encodeURIComponent(name)}/default`,
        method: 'PUT',
      }),
      invalidatesTags: (_result, _error, { name }) => [
        { type, id: name },
        { type, id: 'LIST' },
      ],
    }),
    deleteToken: builder.mutation<{ ok: boolean }, { teamId: string; name: string }>({
      query: ({ teamId, name }) => ({
        url: `${tenantBase(teamId)}/tokens/${encodeURIComponent(name)}`,
        method: 'DELETE',
      }),
      invalidatesTags: (_result, _error, { name }) => [
        { type, id: name },
        { type, id: 'LIST' },
      ],
    }),
  }),
  overrideExisting: true,
});

export const {
  useGetTokensQuery,
  usePutTokenMutation,
  useSetDefaultTokenMutation,
  useDeleteTokenMutation,
} = tokenApi;
