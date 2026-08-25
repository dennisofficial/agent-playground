'use client';

import { auth } from '@/lib/auth';
import { env } from '@/lib/env';
import { axiosQuery } from '@/redux/query/axiosQuery';
import { createApi } from '@reduxjs/toolkit/query/react';
import axios from 'axios';

export enum EBaseApiCacheTags {
  SESSION = 'SESSION',
  ORG = 'ORG',
  ORG_MEMBER = 'ORG_MEMBER',
  REPO = 'REPO',
  JOB = 'JOB',
  CREDENTIALS = 'CREDENTIALS',
  AGENT_CREDENTIALS = 'AGENT_CREDENTIALS',
}

const REFETCH_ON_MOUNT_SECONDS = 30;

const axiosInstance = axios.create({
  baseURL: env.NEXT_PUBLIC_BACKEND_URL,
  headers: {
    Accept: 'application/json',
    'Content-Type': 'application/json',
  },
  withCredentials: true, // cookie session rides on credentialed CORS
});

// 401 → refresh → retry (and re-probe /auth/session on failure) — reuses the @dltech/jwt-auth client.
auth.attachInterceptors(axiosInstance);

export const baseApi = createApi({
  reducerPath: 'baseApi',
  baseQuery: axiosQuery(axiosInstance),
  tagTypes: Object.values(EBaseApiCacheTags),
  endpoints: () => ({}),
  refetchOnMountOrArgChange: REFETCH_ON_MOUNT_SECONDS,
  refetchOnReconnect: true,
});
