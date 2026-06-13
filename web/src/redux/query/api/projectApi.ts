'use client';

import { baseApi, EBaseApiCacheTags } from '@/redux/query/api/baseApi';
import type { ProjectRecord } from '@/lib/admin-api';

const type = EBaseApiCacheTags.PROJECT;

const tenantBase = (teamId: string) => `/tenants/${encodeURIComponent(teamId)}`;

export const projectApi = baseApi.injectEndpoints({
  endpoints: (builder) => ({
    getProjects: builder.query<ProjectRecord[], string>({
      query: (teamId) => ({
        url: `${tenantBase(teamId)}/projects`,
      }),
      providesTags: (result) =>
        result
          ? [{ type, id: 'LIST' }, ...result.map(({ projectId: id }) => ({ type, id }))]
          : [{ type, id: 'LIST' }],
    }),
    createProject: builder.mutation<
      ProjectRecord,
      {
        teamId: string;
        dto: {
          projectId: string;
          displayName: string;
          gitUrl: string;
          defaultBranch?: string;
          tokenName?: string;
        };
      }
    >({
      query: ({ teamId, dto }) => ({
        url: `${tenantBase(teamId)}/projects`,
        method: 'POST',
        data: dto,
      }),
      invalidatesTags: [{ type, id: 'LIST' }],
    }),
    updateProject: builder.mutation<
      ProjectRecord,
      {
        teamId: string;
        projectId: string;
        dto: Partial<{
          displayName: string;
          gitUrl: string;
          defaultBranch: string;
          tokenName: string | null;
        }>;
      }
    >({
      query: ({ teamId, projectId, dto }) => ({
        url: `${tenantBase(teamId)}/projects/${encodeURIComponent(projectId)}`,
        method: 'PATCH',
        data: dto,
      }),
      invalidatesTags: (_result, _error, { projectId: id }) => [
        { type, id },
        { type, id: 'LIST' },
      ],
    }),
  }),
  overrideExisting: true,
});

export const { useGetProjectsQuery, useCreateProjectMutation, useUpdateProjectMutation } =
  projectApi;
