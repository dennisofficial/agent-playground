'use client';

/**
 * Drop-in, inert replacements for the TanStack Query hooks. A legacy data-hook module whose backend
 * endpoints aren't wired yet swaps ONLY its import line
 *   from "@tanstack/react-query"  →  from "./_tanstack-shim"
 * and compiles unchanged: reads resolve EMPTY (so the page still renders while the slice is unbuilt),
 * writes are LOUD (throw "Not Implemented" on invoke — an unwired action can never look like it
 * succeeded), and the cache client is a no-op. The generics mirror TanStack's positional type params
 * so both inference (from `queryFn` / `mutationFn`) and explicit `useMutation<TData, TError, TVars>()`
 * call sites type-check identically. Grep `_tanstack-shim` to find modules still awaiting RTK endpoints.
 */
import { stubMutation, stubQuery, type MutationResultLike, type QueryResultLike } from './_stub';

// TanStack: useQuery<TQueryFnData, TError, TData, TQueryKey>
export function useQuery<
  TQueryFnData = unknown,
  _TError = unknown,
  TData = TQueryFnData,
  _TQueryKey = unknown,
>(_options: {
  queryFn?: (...args: any[]) => TQueryFnData | Promise<TQueryFnData>;
  select?: (data: TQueryFnData) => TData;
  [key: string]: unknown;
}): QueryResultLike<TData> {
  return stubQuery<TData>();
}

// TanStack: useMutation<TData, TError, TVariables, TContext>
export function useMutation<
  TData = unknown,
  TError = Error,
  TVariables = void,
  TContext = unknown,
>(_options: {
  mutationFn?: (variables: TVariables) => TData | Promise<TData>;
  onMutate?: (variables: TVariables) => TContext | Promise<TContext> | void;
  onSuccess?: (data: TData, variables: TVariables, context: TContext) => unknown;
  onError?: (error: TError, variables: TVariables, context: TContext | undefined) => unknown;
  onSettled?: (
    data: TData | undefined,
    error: TError | null,
    variables: TVariables,
    context: TContext | undefined,
  ) => unknown;
  [key: string]: unknown;
}): MutationResultLike<TData, TVariables> {
  return stubMutation<TData, TVariables>('mutation');
}

/** Inert fan-out — returns no results; the one consumer (`useAllRepos`) folds it to an empty list. */
export function useQueries<TResult = unknown>(_options: {
  queries: readonly unknown[];
  combine?: (results: TResult[]) => unknown;
  [key: string]: unknown;
}): TResult[] {
  return [];
}

/** No-op cache client — invalidate/set/etc. do nothing until a real store-backed cache exists. */
export function useQueryClient() {
  return {
    invalidateQueries: (_filters?: unknown): Promise<void> => Promise.resolve(),
    setQueryData: <TData>(
      _key?: unknown,
      _updater?: TData | ((old: TData | undefined) => TData | undefined),
    ): undefined => undefined,
    getQueryData: <TData>(_key?: unknown): TData | undefined => undefined,
    getQueriesData: <TData>(_filters?: unknown): [unknown, TData | undefined][] => [],
    removeQueries: (_filters?: unknown): void => {},
    cancelQueries: (_filters?: unknown): Promise<void> => Promise.resolve(),
    refetchQueries: (_filters?: unknown): Promise<void> => Promise.resolve(),
  };
}
