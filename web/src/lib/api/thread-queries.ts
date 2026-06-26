'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { qk } from './query-keys';
import {
  approveThread,
  createThread,
  deleteThread,
  fetchContextFile,
  fetchMessages,
  fetchOrgRepos,
  fetchPipeline,
  fetchThreadContext,
  renameThread,
  sayMessage,
  type ApproveBody,
  type CreateThreadBody,
  type ThreadMessage,
  type ThreadRef,
} from './thread-api';
import { addQueuedSend } from './queued-sends';
import { isLiveTurnActive } from './thread-stream';

/** Tanstack Query hooks over the org → repo → thread API. */

const hasRef = (ref: ThreadRef) => Boolean(ref.orgId && ref.repoId && ref.threadId);

/** A thread's durable message log. SSE keeps it fresh via `useThreadEvents` (refetch on any frame). */
export function useThreadMessages(ref: ThreadRef) {
  return useQuery({
    queryKey: qk.threadMessages(ref),
    queryFn: () => fetchMessages(ref),
    enabled: hasRef(ref),
    staleTime: 5_000,
  });
}

/** A thread's pipeline (job + sections), or `{ status: 'no_job' }` before a plan is approved. */
export function usePipeline(ref: ThreadRef) {
  return useQuery({
    queryKey: qk.threadPipeline(ref),
    queryFn: () => fetchPipeline(ref),
    enabled: hasRef(ref),
    staleTime: 5_000,
  });
}

/** A thread's `/context` files (specs + artifacts). SSE keeps it fresh via `useThreadEvents`. */
export function useThreadContext(ref: ThreadRef) {
  return useQuery({
    queryKey: qk.threadContext(ref),
    queryFn: () => fetchThreadContext(ref),
    enabled: hasRef(ref),
    staleTime: 5_000,
  });
}

/** One `/context` file's content (`path` bucket-relative, e.g. `specs/plan.md`). Lazy — only when opened. */
export function useContextFile(ref: ThreadRef, path: string | null) {
  return useQuery({
    queryKey: qk.threadContextFile(ref, path ?? ''),
    queryFn: () => fetchContextFile(ref, path!),
    enabled: hasRef(ref) && Boolean(path),
    staleTime: 5_000,
  });
}

/** An org's connected repos — the create-thread repo picker. */
export function useOrgRepos(orgId: string) {
  return useQuery({
    queryKey: qk.orgRepos(orgId),
    queryFn: () => fetchOrgRepos(orgId),
    enabled: Boolean(orgId),
    staleTime: 30_000,
  });
}

interface SayContext {
  prev?: ThreadMessage[];
}

/**
 * Post a message into the thread. Optimistically appends a local user bubble so the composer feels
 * instant; the authoritative list is refetched on settle (and again when the SSE signal fires), which
 * reconciles the optimistic row with the durable one.
 */
export function useSay(ref: ThreadRef) {
  const qc = useQueryClient();
  return useMutation<{ ts: string }, Error, string, SayContext>({
    mutationFn: (text: string) => sayMessage(ref, text),
    onMutate: async (text) => {
      const key = qk.threadMessages(ref);
      await qc.cancelQueries({ queryKey: key });
      const prev = qc.getQueryData<ThreadMessage[]>(key);
      // A message sent while a turn is still streaming is QUEUED behind it (the brain serializes turns
      // per thread). Flag it so the UI relays the queued state instead of pretending it was handled.
      const queued = isLiveTurnActive(ref.threadId);
      if (queued) addQueuedSend(ref.threadId, text);
      const optimistic: ThreadMessage = {
        ts: `local-${Date.now()}`,
        author: 'user',
        authorId: 'me',
        authorName: 'You',
        text,
        kind: 'chat',
        postedAt: new Date().toISOString(),
        local: true,
        queued,
      };
      qc.setQueryData<ThreadMessage[]>(key, [...(prev ?? []), optimistic]);
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
export function useApprove(ref: ThreadRef) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: ApproveBody) => approveThread(ref, body),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: qk.threadMessages(ref) });
      void qc.invalidateQueries({ queryKey: qk.threadPipeline(ref) });
    },
  });
}

/** Create a thread in a repo (posts the first message). Invalidates the cross-org inbox on success. */
export function useCreateThread(orgId: string, repoId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: CreateThreadBody) => createThread(orgId, repoId, body),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: qk.allThreads() });
    },
  });
}

/** Rename a thread (the only thread Update op). Refreshes the inbox so the new title shows everywhere. */
export function useRenameThread(ref: ThreadRef) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (title: string) => renameThread(ref, title),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: qk.allThreads() });
    },
  });
}

/** Delete a thread (closes its sandbox + removes its messages). Refreshes the inbox. */
export function useDeleteThread(ref: ThreadRef) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: () => deleteThread(ref),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: qk.allThreads() });
    },
  });
}
