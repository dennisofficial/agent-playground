import type { CurrentUserResponse } from '@workspace/shared';
import { baseApi, EBaseApiCacheTags } from './baseApi';

export const authApi = baseApi.injectEndpoints({
  overrideExisting: true,
  endpoints: (build) => ({
    getSession: build.query<CurrentUserResponse, void>({
      query: () => ({ url: '/auth/session', method: 'GET' }),
      providesTags: [EBaseApiCacheTags.SESSION],
    }),
  }),
});

export const { useGetSessionQuery } = authApi;
