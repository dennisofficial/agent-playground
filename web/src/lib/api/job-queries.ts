'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { qk } from './query-keys';
import {
  answerQuestion,
  provideSecret,
  approveThread,
  createJob,
  deleteThread,
  fetchContextFile,
  fetchMessages,
  fetchOrgRepos,
  fetchRepoBranches,
  fetchPipeline,
  fetchThreadContext,
  renameJob,
  retryJob,
  sayMessage,
  type AnswerQuestionBody,
  type ProvideSecretBody,
  type ApproveBody,
  type CreateThreadBody,
  type JobMessage,
  type JobRef,
} from './job-api';
import { addQueuedSend } from './queued-sends';
import { isLiveTurnActive } from './job-stream';

/** Tanstack Query hooks over the org → repo → thread API. */

const hasRef = (ref: JobRef) => Boolean(ref.orgId && ref.repoId && ref.jobId);

/** A thread's durable message log. SSE keeps it fresh via `useJobEvents` (refetch on any frame). */
export function useJobMessages(ref: JobRef) {
  return useQuery({
    queryKey: qk.threadMessages(ref),
    queryFn: () => fetchMessages(ref),
    enabled: hasRef(ref),
    staleTime: 5_000,
  });
}

/** A thread's pipeline (job + threads), or `{ status: 'no_job' }` before a plan is approved. */
export function usePipeline(ref: JobRef) {
  return useQuery({
    queryKey: qk.threadPipeline(ref),
    queryFn: () => fetchPipeline(ref),
    enabled: hasRef(ref),
    staleTime: 5_000,
  });
}

/** A thread's `/context` files (specs + artifacts). SSE keeps it fresh via `useJobEvents`. */
export function useJobContext(ref: JobRef) {
  return useQuery({
    queryKey: qk.threadContext(ref),
    queryFn: () => fetchThreadContext(ref),
    enabled: hasRef(ref),
    staleTime: 5_000,
  });
}

/** One `/context` file's content (`path` bucket-relative, e.g. `specs/plan.md`). Lazy — only when opened. */
export function useContextFile(ref: JobRef, path: string | null) {
  return useQuery({
    queryKey: qk.threadContextFile(ref, path ?? ''),
    queryFn: () => fetchContextFile(ref, path!),
    enabled: hasRef(ref) && Boolean(path),
    staleTime: 5_000,
  });
}

/** An org's connected repos — the create-job repo picker. */
export function useOrgRepos(orgId: string) {
  return useQuery({
    queryKey: qk.orgRepos(orgId),
    queryFn: () => fetchOrgRepos(orgId),
    enabled: Boolean(orgId),
    staleTime: 30_000,
  });
}

/** A repo's branches — the create-job base-branch picker (hits GitHub via the org token). */
export function useRepoBranches(orgId: string, repoId: string) {
  return useQuery({
    queryKey: qk.repoBranches(orgId, repoId),
    queryFn: () => fetchRepoBranches(orgId, repoId),
    enabled: Boolean(orgId && repoId),
    staleTime: 30_000,
  });
}

interface SayContext {
  prev?: JobMessage[];
}

/**
 * Post a message into the thread. Optimistically appends a local user bubble so the composer feels
 * instant; the authoritative list is refetched on settle (and again when the SSE signal fires), which
 * reconciles the optimistic row with the durable one.
 */
export function useSay(ref: JobRef) {
  const qc = useQueryClient();
  return useMutation<{ ts: string }, Error, string, SayContext>({
    mutationFn: (text: string) => sayMessage(ref, text),
    onMutate: async (text) => {
      const key = qk.threadMessages(ref);
      await qc.cancelQueries({ queryKey: key });
      const prev = qc.getQueryData<JobMessage[]>(key);
      // A message sent while a turn is still streaming is QUEUED behind it (the brain serializes turns
      // per thread). Flag it so the UI relays the queued state instead of pretending it was handled.
      const queued = isLiveTurnActive(ref.jobId);
      if (queued) addQueuedSend(ref.jobId, text);
      const optimistic: JobMessage = {
        ts: `local-${Date.now()}`,
        author: 'user',
        authorId: 'me',
        authorName: 'You',
        text,
        kind: 'chat',
        source: 'operator',
        postedAt: new Date().toISOString(),
        local: true,
        queued,
      };
      qc.setQueryData<JobMessage[]>(key, [...(prev ?? []), optimistic]);
      return { prev };
    },
    onError: (_e, _text, ctx) => {
      if (ctx?.prev) qc.setQueryData(qk.threadMessages(ref), ctx.prev);
    },
    onSettled: () => {
      void qc.invalidateQueries({ queryKey: qk.threadMessages(ref) });
    },
  });
}

/** Submit a plan verdict (approve / request changes / deny). Refreshes the conversation + pipeline. */
export function useApprove(ref: JobRef) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: ApproveBody) => approveThread(ref, body),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: qk.threadMessages(ref) });
      void qc.invalidateQueries({ queryKey: qk.threadPipeline(ref) });
    },
  });
}

/** Re-drive a halted (failed/paused) build — the navigator "Retry"/"Re-ping" buttons. Refreshes the
 *  pipeline + conversation + inbox so the thread flips back to running. */
export function useRetryJob(ref: JobRef) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: () => retryJob(ref),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: qk.threadPipeline(ref) });
      void qc.invalidateQueries({ queryKey: qk.threadMessages(ref) });
      void qc.invalidateQueries({ queryKey: qk.allJobs() });
    },
  });
}

/** Answer a formal `ask_question` card. Refreshes the conversation (the card flips to answered + the
 *  brain's next turn lands). */
export function useAnswerQuestion(ref: JobRef) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: AnswerQuestionBody) => answerQuestion(ref, body),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: qk.threadMessages(ref) });
    },
  });
}

/** Provide a secret value for a `request_secret` card (repo onboarding). The value goes straight to the
 *  encrypted store; the card flips to "provided" and the brain continues. */
export function useProvideSecret(ref: JobRef) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: ProvideSecretBody) => provideSecret(ref, body),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: qk.threadMessages(ref) });
    },
  });
}

/** Create a thread in a repo (posts the first message). Invalidates the cross-org inbox on success. */
export function useCreateThread(orgId: string, repoId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: CreateThreadBody) => createJob(orgId, repoId, body),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: qk.allJobs() });
    },
  });
}

/** Rename a thread (the only thread Update op). Refreshes the inbox so the new title shows everywhere. */
export function useRenameJob(ref: JobRef) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (title: string) => renameJob(ref, title),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: qk.allJobs() });
    },
  });
}

/** Delete a thread (closes its sandbox + removes its messages). Refreshes the inbox. */
export function useDeleteJob(ref: JobRef) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: () => deleteThread(ref),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: qk.allJobs() });
    },
  });
}
