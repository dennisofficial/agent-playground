import { getRealtimeClient } from '@/lib/realtime/realtime-client';
import { makeSocketListOpener, streamDocument, streamList } from '@workspace/pg-realtime/rtk';
import type {
  CreateJobDto,
  CreateJobResult,
  InboundItemInput,
  InboundMessageView,
  JobListItem,
  JobView,
  SendMessageResult,
  TaskView,
  ThreadGroupView,
  ThreadMessageView,
  ThreadView,
} from '@workspace/shared';
import { baseApi, EBaseApiCacheTags } from './baseApi';

export const jobsApi = baseApi.injectEndpoints({
  overrideExisting: true,
  endpoints: (build) => ({
    createJob: build.mutation<CreateJobResult, CreateJobDto>({
      query: (body) => ({ url: `/jobs`, method: 'POST', data: body }),
      invalidatesTags: [EBaseApiCacheTags.JOB],
    }),

    archiveJob: build.mutation<JobListItem, string>({
      query: (jobId) => ({ url: `/jobs/${jobId}/archive`, method: 'POST' }),
      invalidatesTags: (_result, _error, jobId) => [
        EBaseApiCacheTags.JOB,
        { type: EBaseApiCacheTags.JOB, id: jobId },
      ],
    }),

    // Post a typed batch into a job (the inbound-message choke point). The operator bubble + any reply arrive
    // via the messages/realtime stream (streamList on getJobMessages), so no optimistic wiring is needed here.
    sendMessage: build.mutation<
      SendMessageResult,
      { jobId: string; messages: InboundItemInput[]; threadId?: string }
    >({
      query: ({ jobId, messages, threadId }) => ({
        url: `/jobs/${jobId}/messages`,
        method: 'POST',
        data: threadId ? { messages, threadId } : { messages },
      }),
      invalidatesTags: (_result, _error, { jobId }) => [
        { type: EBaseApiCacheTags.JOB, id: `${jobId}:messages` },
      ],
    }),

    getJobs: build.query<JobListItem[], void>({
      queryFn: () => ({ data: [] }),
      providesTags: [EBaseApiCacheTags.JOB],
      onCacheEntryAdded: (_arg, api) =>
        streamList<JobListItem>({
          url: 'jobs',
          open: makeSocketListOpener(getRealtimeClient(), 'jobs'),
          lifecycle: api,
        }),
    }),

    getJob: build.query<JobView, string>({
      queryFn: (jobId) =>
        new Promise((resolve) => {
          const query = getRealtimeClient().query('job_detail', { filter: { jobId } });
          const unsubscribe = query.onChange((changes) => {
            const row = changes.find((c) => c.op === 'add' || c.op === 'update')?.row;
            if (!row) return;
            unsubscribe();
            resolve({ data: row as JobView });
          });
        }),
      providesTags: (_result, _error, jobId) => [{ type: EBaseApiCacheTags.JOB, id: jobId }],
      onCacheEntryAdded: (jobId, api) =>
        streamDocument<JobView>({
          url: 'job_detail',
          open: makeSocketListOpener(getRealtimeClient(), 'job_detail', { filter: { jobId } }),
          lifecycle: api,
        }),
    }),

    getThreadGroups: build.query<ThreadGroupView[], string>({
      queryFn: () => ({ data: [] }),
      providesTags: (_result, _error, jobId) => [
        { type: EBaseApiCacheTags.JOB, id: `${jobId}:groups` },
      ],
      onCacheEntryAdded: (jobId, api) =>
        streamList<ThreadGroupView>({
          url: 'thread_groups',
          open: makeSocketListOpener(getRealtimeClient(), 'thread_groups', { filter: { jobId } }),
          lifecycle: api,
        }),
    }),

    getThreads: build.query<ThreadView[], { jobId: string; groupId?: string; kind?: string }>({
      queryFn: () => ({ data: [] }),
      providesTags: (_result, _error, { jobId }) => [
        { type: EBaseApiCacheTags.JOB, id: `${jobId}:threads` },
      ],
      onCacheEntryAdded: ({ jobId }, api) =>
        streamList<ThreadView>({
          url: 'threads',
          // Server streams all threads for the job (same as the old SSE endpoint); groupId/kind are
          // client-side cache-key/scoping args only — they are NOT fields on the threads model.
          open: makeSocketListOpener(getRealtimeClient(), 'threads', {
            filter: { jobId },
          }),
          lifecycle: api,
        }),
    }),

    getJobMessages: build.query<ThreadMessageView[], string>({
      queryFn: () => ({ data: [] }),
      providesTags: (_result, _error, jobId) => [
        { type: EBaseApiCacheTags.JOB, id: `${jobId}:messages` },
      ],
      onCacheEntryAdded: (jobId, api) =>
        streamList<ThreadMessageView>({
          url: 'thread_messages',
          open: makeSocketListOpener(getRealtimeClient(), 'thread_messages', {
            filter: { jobId },
          }),
          lifecycle: api,
        }),
    }),

    getThreadMessages: build.query<ThreadMessageView[], { jobId: string; threadId: string }>({
      queryFn: () => ({ data: [] }),
      providesTags: (_result, _error, { threadId }) => [
        { type: EBaseApiCacheTags.JOB, id: `thread:${threadId}` },
      ],
      onCacheEntryAdded: ({ threadId }, api) =>
        streamList<ThreadMessageView>({
          url: 'thread_messages',
          open: makeSocketListOpener(getRealtimeClient(), 'thread_messages', {
            filter: { threadId },
          }),
          lifecycle: api,
        }),
    }),

    getJobTasks: build.query<TaskView[], string>({
      queryFn: () => ({ data: [] }),
      providesTags: (_result, _error, jobId) => [
        { type: EBaseApiCacheTags.JOB, id: `${jobId}:tasks` },
      ],
      onCacheEntryAdded: (jobId, api) =>
        streamList<TaskView>({
          url: 'tasks',
          open: makeSocketListOpener(getRealtimeClient(), 'tasks', { filter: { jobId } }),
          lifecycle: api,
        }),
    }),

    // The pending queue (sent, not yet consumed). The list may include CONSUMED rows that streamed by; the
    // composer's pending zone renders only `status === 'pending'`.
    getInbound: build.query<InboundMessageView[], string>({
      queryFn: () => ({ data: [] }),
      providesTags: (_result, _error, jobId) => [
        { type: EBaseApiCacheTags.JOB, id: `${jobId}:inbound` },
      ],
      onCacheEntryAdded: (jobId, api) =>
        streamList<InboundMessageView>({
          url: 'inbound_messages',
          open: makeSocketListOpener(getRealtimeClient(), 'inbound_messages', {
            filter: { jobId },
          }),
          lifecycle: api,
        }),
    }),
  }),
});

export const {
  useCreateJobMutation,
  useArchiveJobMutation,
  useSendMessageMutation,
  useGetJobsQuery,
  useGetJobQuery,
  useGetThreadGroupsQuery,
  useGetThreadsQuery,
  useGetJobMessagesQuery,
  useGetThreadMessagesQuery,
  useGetJobTasksQuery,
  useGetInboundQuery,
} = jobsApi;
