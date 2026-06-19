'use client';

import { baseApi, EBaseApiCacheTags } from '@/redux/query/api/baseApi';
import type { BoardTaskView, PlanView } from '@workspace/shared';

/**
 * Read-only Plan Viewer endpoints. Backed by the api app's PlanViewController
 * (`/tenants/:teamId/plans/:taskId` and `/tenants/:teamId/board`).
 */
export const planApi = baseApi.injectEndpoints({
  endpoints: (builder) => ({
    getPlan: builder.query<
      PlanView,
      { teamId: string; taskId: string | number }
    >({
      query: ({ teamId, taskId }) => ({
        url: `/tenants/${encodeURIComponent(teamId)}/plans/${encodeURIComponent(String(taskId))}`,
      }),
      providesTags: (_result, _error, { teamId, taskId }) => [
        { type: EBaseApiCacheTags.PLAN, id: `${teamId}:${taskId}` },
      ],
    }),
    getBoard: builder.query<BoardTaskView[], { teamId: string }>({
      query: ({ teamId }) => ({
        url: `/tenants/${encodeURIComponent(teamId)}/board`,
      }),
      providesTags: (_result, _error, { teamId }) => [
        { type: EBaseApiCacheTags.BOARD, id: teamId },
      ],
    }),
  }),
  overrideExisting: true,
});

export const { useGetPlanQuery, useGetBoardQuery } = planApi;
