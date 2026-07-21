import { env } from '@/lib/env';
import { streamList } from '@workspace/pg-realtime/rtk';
import type {
  CreateJobDto,
  CreateJobResult,
  JobListItem,
  JobView,
  TaskView,
  ThreadGroupView,
  ThreadMessageView,
  ThreadView,
} from '@workspace/shared';
import { baseApi, EBaseApiCacheTags } from './baseApi';
import { sseOpener } from './sse-opener';

const BACKEND = env.NEXT_PUBLIC_BACKEND_URL;

export const jobsApi = baseApi.injectEndpoints({
  overrideExisting: true,
  endpoints: (build) => ({
    createJob: build.mutation<CreateJobResult, CreateJobDto>({
      query: (body) => ({ url: `/jobs`, method: 'POST', data: body }),
      invalidatesTags: [EBaseApiCacheTags.JOB],
    }),

    getJobs: build.query<JobListItem[], void>({
      query: () => ({ url: `/jobs`, method: 'GET' }),
      providesTags: [EBaseApiCacheTags.JOB],
      onCacheEntryAdded: (_arg, api) =>
        streamList<JobListItem>({
          url: new URL(`/jobs/realtime`, BACKEND).toString(),
          open: sseOpener,
          lifecycle: api,
        }),
    }),

    getJob: build.query<JobView, string>({
      query: (jobId) => ({ url: `/jobs/${jobId}`, method: 'GET' }),
      providesTags: (_result, _error, jobId) => [{ type: EBaseApiCacheTags.JOB, id: jobId }],
    }),

    getThreadGroups: build.query<ThreadGroupView[], string>({
      query: (jobId) => ({ url: `/jobs/${jobId}/thread-groups`, method: 'GET' }),
      providesTags: (_result, _error, jobId) => [
        { type: EBaseApiCacheTags.JOB, id: `${jobId}:groups` },
      ],
      onCacheEntryAdded: (jobId, api) =>
        streamList<ThreadGroupView>({
          url: new URL(`/jobs/${jobId}/thread-groups/realtime`, BACKEND).toString(),
          open: sseOpener,
          lifecycle: api,
        }),
    }),

    getThreads: build.query<ThreadView[], { jobId: string; groupId?: string; kind?: string }>({
      query: ({ jobId, groupId, kind }) => {
        const p = new URLSearchParams();
        if (groupId) p.set('groupId', groupId);
        if (kind) p.set('kind', kind);
        const qs = p.toString();
        return { url: `/jobs/${jobId}/threads${qs ? `?${qs}` : ''}`, method: 'GET' };
      },
      providesTags: (_result, _error, { jobId }) => [
        { type: EBaseApiCacheTags.JOB, id: `${jobId}:threads` },
      ],
      onCacheEntryAdded: ({ jobId }, api) =>
        streamList<ThreadView>({
          url: new URL(`/jobs/${jobId}/threads/realtime`, BACKEND).toString(),
          open: sseOpener,
          lifecycle: api,
        }),
    }),

    getJobMessages: build.query<ThreadMessageView[], string>({
      query: (jobId) => ({ url: `/jobs/${jobId}/messages`, method: 'GET' }),
      providesTags: (_result, _error, jobId) => [
        { type: EBaseApiCacheTags.JOB, id: `${jobId}:messages` },
      ],
      onCacheEntryAdded: (jobId, api) =>
        streamList<ThreadMessageView>({
          url: new URL(`/jobs/${jobId}/messages/realtime`, BACKEND).toString(),
          open: sseOpener,
          lifecycle: api,
        }),
    }),

    getThreadMessages: build.query<ThreadMessageView[], { jobId: string; threadId: string }>({
      query: ({ jobId, threadId }) => ({
        url: `/jobs/${jobId}/threads/${threadId}/messages`,
        method: 'GET',
      }),
      providesTags: (_result, _error, { threadId }) => [
        { type: EBaseApiCacheTags.JOB, id: `thread:${threadId}` },
      ],
      onCacheEntryAdded: ({ jobId, threadId }, api) =>
        streamList<ThreadMessageView>({
          url: new URL(`/jobs/${jobId}/threads/${threadId}/messages/realtime`, BACKEND).toString(),
          open: sseOpener,
          lifecycle: api,
        }),
    }),

    getJobTasks: build.query<TaskView[], string>({
      query: (jobId) => ({ url: `/jobs/${jobId}/tasks`, method: 'GET' }),
      providesTags: (_result, _error, jobId) => [
        { type: EBaseApiCacheTags.JOB, id: `${jobId}:tasks` },
      ],
      onCacheEntryAdded: (jobId, api) =>
        streamList<TaskView>({
          url: new URL(`/jobs/${jobId}/tasks/realtime`, BACKEND).toString(),
          open: sseOpener,
          lifecycle: api,
        }),
    }),
  }),
});

export const {
  useCreateJobMutation,
  useGetJobsQuery,
  useGetJobQuery,
  useGetThreadGroupsQuery,
  useGetThreadsQuery,
  useGetJobMessagesQuery,
  useGetThreadMessagesQuery,
  useGetJobTasksQuery,
} = jobsApi;
