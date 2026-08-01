import { pgbase } from '@/lib/pgbase/client';
import {
  buildJobView,
  inboundToView,
  jobToListItem,
  taskToView,
  threadGroupToView,
  threadToView,
} from '@/lib/pgbase/adapters';
import { liveListEndpoint } from '@/lib/pgbase/rtk';
import { liveThreadMessagesEndpoint } from '@/lib/pgbase/thread-messages';
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
    // via the messages/realtime stream (the `thread_messages` live feed on getJobMessages), so no optimistic
    // wiring is needed here.
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
      ...liveListEndpoint(pgbase.Job, jobToListItem),
      providesTags: [EBaseApiCacheTags.JOB],
    }),

    // `JobView.threadGroups` used to be a server-composed nested tree (a `job_detail` view). pgbase has
    // no live joins, so this subscribes to `Job`, `ThreadGroup`, and `Thread` (all own-column, filtered
    // by `jobId`/`id`) and rebuilds the tree client-side on every delta from any of the three — the same
    // pattern the pgbase example app uses to join `Task` to `Job` in the browser. `queryFn` resolves the
    // initial snapshot from all three; `onCacheEntryAdded` keeps it live off the same three subscriptions.
    getJob: build.query<JobView, string>({
      queryFn: async (jobId) => {
        const jobSub = pgbase.Job.createSubscription();
        const groupSub = pgbase.ThreadGroup.createSubscription();
        const threadSub = pgbase.Thread.createSubscription();
        try {
          const [jobRows, groups, threads] = await Promise.all([
            jobSub.query({ where: { id: jobId } }),
            groupSub.query({ where: { jobId } }),
            threadSub.query({ where: { jobId } }),
          ]);
          const job = jobRows[0];
          if (!job) {
            jobSub.close();
            groupSub.close();
            threadSub.close();
            return { error: { message: 'Job not found' } };
          }
          return {
            data: buildJobView(job, groups, threads),
            meta: { jobSub, groupSub, threadSub },
          };
        } catch (err) {
          jobSub.close();
          groupSub.close();
          threadSub.close();
          return { error: { message: err instanceof Error ? err.message : String(err) } };
        }
      },
      providesTags: (_result, _error, jobId) => [{ type: EBaseApiCacheTags.JOB, id: jobId }],
      onCacheEntryAdded: async (_jobId, api) => {
        const { meta } = await api.cacheDataLoaded;
        const subs = meta as
          | {
              jobSub: ReturnType<typeof pgbase.Job.createSubscription>;
              groupSub: ReturnType<typeof pgbase.ThreadGroup.createSubscription>;
              threadSub: ReturnType<typeof pgbase.Thread.createSubscription>;
            }
          | undefined;
        if (!subs) return;

        let job = subs.jobSub.getSnapshot()[0];
        let groups = subs.groupSub.getSnapshot();
        let threads = subs.threadSub.getSnapshot();
        // A job that disappears (deleted, or scoped out of the caller's orgs) leaves the last known
        // view in the cache rather than clearing it — same "stale until reconnect" tradeoff pgbase
        // itself takes for a row that falls out of RLS scope without REPLICA IDENTITY FULL.
        const recompute = () => {
          if (!job) return;
          api.updateCachedData(() => buildJobView(job!, groups, threads));
        };

        const offJob = subs.jobSub.subscribe((rows) => {
          job = rows[0];
          recompute();
        });
        const offGroups = subs.groupSub.subscribe((rows) => {
          groups = rows;
          recompute();
        });
        const offThreads = subs.threadSub.subscribe((rows) => {
          threads = rows;
          recompute();
        });

        await api.cacheEntryRemoved;
        offJob();
        offGroups();
        offThreads();
        subs.jobSub.close();
        subs.groupSub.close();
        subs.threadSub.close();
      },
    }),

    getThreadGroups: build.query<ThreadGroupView[], string>({
      ...liveListEndpoint(pgbase.ThreadGroup, (g) => threadGroupToView(g, []), (jobId: string) => ({
        where: { jobId },
      })),
      providesTags: (_result, _error, jobId) => [
        { type: EBaseApiCacheTags.JOB, id: `${jobId}:groups` },
      ],
    }),

    getThreads: build.query<ThreadView[], { jobId: string; groupId?: string; kind?: string }>({
      // groupId/kind are client-side cache-key/scoping args only — they are NOT fields on the threads
      // model (same as the pre-pgbase feed: the server streams every thread for the job).
      ...liveListEndpoint(pgbase.Thread, threadToView, ({ jobId }: { jobId: string }) => ({
        where: { jobId },
      })),
      providesTags: (_result, _error, { jobId }) => [
        { type: EBaseApiCacheTags.JOB, id: `${jobId}:threads` },
      ],
    }),

    // `ThreadMessage.subagentId → Subagent.status/endedAt` used to arrive pre-joined. `Subagent` is
    // narrowly client-readable now (`id`/`orgId`/`status`/`endedAt`, no `jobId`/`threadId` column to
    // filter a live subscription on), so `liveThreadMessagesEndpoint` composes the two feeds itself —
    // see `lib/pgbase/thread-messages.ts`.
    getJobMessages: build.query<ThreadMessageView[], string>({
      ...liveThreadMessagesEndpoint((jobId: string) => ({ jobId })),
      providesTags: (_result, _error, jobId) => [
        { type: EBaseApiCacheTags.JOB, id: `${jobId}:messages` },
      ],
    }),

    getThreadMessages: build.query<ThreadMessageView[], { jobId: string; threadId: string }>({
      ...liveThreadMessagesEndpoint(({ threadId }: { jobId: string; threadId: string }) => ({
        threadId,
      })),
      providesTags: (_result, _error, { threadId }) => [
        { type: EBaseApiCacheTags.JOB, id: `thread:${threadId}` },
      ],
    }),

    getJobTasks: build.query<TaskView[], string>({
      ...liveListEndpoint(pgbase.Task, taskToView, (jobId: string) => ({ where: { jobId } })),
      providesTags: (_result, _error, jobId) => [
        { type: EBaseApiCacheTags.JOB, id: `${jobId}:tasks` },
      ],
    }),

    // The pending queue (sent, not yet consumed). The list may include CONSUMED rows that streamed by; the
    // composer's pending zone renders only `status === 'pending'`.
    getInbound: build.query<InboundMessageView[], string>({
      ...liveListEndpoint(pgbase.InboundMessage, inboundToView, (jobId: string) => ({
        where: { jobId },
      })),
      providesTags: (_result, _error, jobId) => [
        { type: EBaseApiCacheTags.JOB, id: `${jobId}:inbound` },
      ],
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
