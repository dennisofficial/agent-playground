"use client";

/**
 * Migration shims. While the new backend is built out slice by slice, hooks whose endpoints
 * don't exist yet return these instead of hitting the network. Two rules:
 *   - QUERY stubs render empty (a typed `[]` / `undefined`) — an empty state on purpose.
 *   - MUTATION stubs are LOUD: invoking one throws, so an unwired action can never look like
 *     it succeeded. Every stub is greppable (`stubQuery` / `stubMutation` / `notImplemented`).
 *
 * `adaptQuery` / `adaptMutation` map a real RTK Query result onto the same TanStack-shaped
 * surface the existing consumers destructure, so wiring an endpoint is a one-line swap.
 */

export interface QueryResultLike<T> {
  data: T | undefined;
  isLoading: boolean;
  isFetching: boolean;
  isPending: boolean;
  isError: boolean;
  isSuccess: boolean;
  error: unknown;
  refetch: () => Promise<unknown>;
  dataUpdatedAt: number;
  status: "pending" | "error" | "success";
}

export interface MutationResultLike<TData, TVars> {
  mutate: (
    vars: TVars,
    opts?: { onSuccess?: (data: TData) => void; onError?: (err: Error) => void },
  ) => void;
  mutateAsync: (
    vars: TVars,
    opts?: { onSuccess?: (data: TData) => void; onError?: (err: Error) => void },
  ) => Promise<TData>;
  isPending: boolean;
  isError: boolean;
  isSuccess: boolean;
  error: unknown;
  data: TData | undefined;
  variables: TVars | undefined;
  reset: () => void;
}

const noopRefetch = async (): Promise<undefined> => undefined;

/** A settled query result carrying `value` (omit for an empty read) — for endpoints not served yet. */
export function stubQuery<T>(value?: T): QueryResultLike<T> {
  return {
    data: value,
    isLoading: false,
    isFetching: false,
    isPending: false,
    isError: false,
    isSuccess: true,
    error: null,
    refetch: noopRefetch,
    dataUpdatedAt: 0,
    status: "success",
  };
}

/** Throws — an action the backend doesn't support yet must never look like it succeeded. */
export function notImplemented(feature: string): never {
  throw new Error(`[not wired] "${feature}" is not supported by the backend yet.`);
}

/** A mutation whose invocation is loud (throws) — for unwired write endpoints. */
export function stubMutation<TData = unknown, TVars = void>(
  feature: string,
): MutationResultLike<TData, TVars> {
  return {
    mutate: () => notImplemented(feature),
    mutateAsync: () =>
      Promise.reject(new Error(`[not wired] "${feature}" is not supported by the backend yet.`)),
    isPending: false,
    isError: false,
    isSuccess: false,
    error: null,
    data: undefined,
    variables: undefined,
    reset: () => {},
  };
}

// ── Adapters: RTK Query result → the TanStack-shaped surface the consumers expect ──

type RtkQueryResult<T> = {
  data?: T;
  isLoading: boolean;
  isFetching: boolean;
  isError: boolean;
  isSuccess: boolean;
  error?: unknown;
  refetch: () => unknown;
};

export function adaptQuery<T>(r: RtkQueryResult<T>): QueryResultLike<T> {
  return {
    data: r.data,
    isLoading: r.isLoading,
    isFetching: r.isFetching,
    isPending: r.isLoading,
    isError: r.isError,
    isSuccess: r.isSuccess,
    error: r.error ?? null,
    refetch: () => Promise.resolve(r.refetch()),
    dataUpdatedAt: 0,
    status: r.isError ? "error" : r.isSuccess ? "success" : "pending",
  };
}

type RtkTrigger<TData, TVars> = (vars: TVars) => { unwrap: () => Promise<TData> };
type RtkMutationState<TData> = {
  isLoading: boolean;
  isError: boolean;
  isSuccess: boolean;
  error?: unknown;
  data?: TData;
  reset: () => void;
};

export function adaptMutation<TData, TVars>(
  hook: readonly [RtkTrigger<TData, TVars>, RtkMutationState<TData>],
): MutationResultLike<TData, TVars> {
  const [trigger, state] = hook;
  return {
    mutate: (vars, opts) => {
      trigger(vars)
        .unwrap()
        .then((data) => opts?.onSuccess?.(data))
        .catch((err) => opts?.onError?.(err as Error));
    },
    mutateAsync: (vars) => trigger(vars).unwrap(),
    isPending: state.isLoading,
    isError: state.isError,
    isSuccess: state.isSuccess,
    error: state.error ?? null,
    data: state.data,
    variables: (state as { originalArgs?: TVars }).originalArgs,
    reset: state.reset,
  };
}
