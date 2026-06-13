'use client';

import { createApi } from '@reduxjs/toolkit/query/react';
import { axiosQuery } from '@/redux/query/axiosQuery';
import { auth } from '@/lib/auth';

export enum EBaseApiCacheTags {
  PROJECT = 'PROJECT',
  TOKEN = 'TOKEN',
  TENANT = 'TENANT',
  FACT = 'FACT',
}

export const baseApi = createApi({
  reducerPath: 'baseApi',
  baseQuery: axiosQuery(auth.httpClient),
  tagTypes: Object.values(EBaseApiCacheTags),
  endpoints: () => ({}),
  refetchOnMountOrArgChange: 30,
  refetchOnReconnect: true,
});
