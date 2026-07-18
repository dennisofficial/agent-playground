import type { SerializedError } from '@reduxjs/toolkit';
import type { BaseQueryFn } from '@reduxjs/toolkit/query';
import { type AxiosInstance, type AxiosRequestConfig, isAxiosError } from 'axios';

type ApiErrorResponse = {
  statusCode: number;
  message: string | string[];
  error: string;
  code?: string;
  [key: string]: unknown;
};

export type NormalizedError = {
  status: number;
  message: string;
  error: string;
  data?: ApiErrorResponse;
};

/**
 * RTK Query baseQuery backed by an axios instance (the house pattern from cubix/rs-crm).
 * 401→refresh→retry lives in the axios interceptors (see `auth.attachInterceptors`), not here.
 * Nest error bodies (`{ statusCode, message, error }`) are normalized to `NormalizedError`.
 */
export const axiosQuery = (
  instance: AxiosInstance,
): BaseQueryFn<AxiosRequestConfig, unknown, NormalizedError | SerializedError> => {
  return async (params) => {
    try {
      const result = await instance(params);
      // 204 → axios yields undefined body, which RTK Query rejects; coerce to null.
      return { data: result.data ?? null };
    } catch (error: unknown) {
      if (isAxiosError<ApiErrorResponse>(error)) {
        const responseData = error.response?.data;
        const status = error.response?.status ?? -1;
        const rawMessage = responseData?.message;
        const message = Array.isArray(rawMessage)
          ? rawMessage.join(', ')
          : (rawMessage ?? error.message);
        return {
          error: {
            status,
            message,
            error: responseData?.error ?? error.name,
            data: responseData,
          } satisfies NormalizedError,
        };
      }
      if (error instanceof Error) {
        return {
          error: {
            message: error.message,
            name: error.name,
            code: (error as { code?: string }).code,
          } satisfies SerializedError,
        };
      }
      return {
        error: {
          message: 'An unexpected error occurred',
        } satisfies SerializedError,
      };
    }
  };
};

export const isNormalizedError = (
  obj: NormalizedError | SerializedError | undefined,
): obj is NormalizedError => !!obj && 'status' in obj;
