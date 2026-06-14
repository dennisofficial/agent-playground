import type { BaseQueryFn } from '@reduxjs/toolkit/query';
import type { AxiosInstance, AxiosRequestConfig } from 'axios';
import { isAxiosError } from 'axios';
import type { SerializedError } from '@reduxjs/toolkit';

interface ApiErrorResponse {
  statusCode: number;
  message: string | string[];
  error: string;
}

export interface NormalizedError {
  status: number;
  message: string;
  error: string;
}

export const axiosQuery =
  (
    instance: AxiosInstance,
  ): BaseQueryFn<AxiosRequestConfig, unknown, NormalizedError | SerializedError> =>
  async (params, api) => {
    try {
      const result = await instance({
        method: api.type === 'mutation' ? 'POST' : 'GET',
        ...params,
      });
      return { data: result.data };
    } catch (error: any) {
      if (isAxiosError<ApiErrorResponse>(error)) {
        const responseData = error.response?.data;
        const status = error.response?.status ?? -1;
        return {
          error: {
            status,
            message: extractErrorMessage(error),
            error: responseData?.error ?? error.name,
          },
        };
      }
      // Non-Axios error — return as SerializedError shape
      return {
        error: {
          message: error?.message,
          name: error?.name,
          code: error?.code,
          stack: error?.stack,
        } as SerializedError,
      };
    }
  };

const extractErrorMessage = (error: any): string => {
  if (isAxiosError<ApiErrorResponse>(error)) {
    const responseData = error.response?.data;
    if (responseData?.message) {
      return Array.isArray(responseData.message)
        ? responseData.message.join(', ')
        : responseData.message;
    }
    return error.message;
  }
  if (error instanceof Error) {
    return error.message;
  }
  return 'An error occurred';
};

export const isNormalizedError = (
  obj: NormalizedError | SerializedError | undefined,
): obj is NormalizedError => {
  if (obj) {
    return 'status' in obj;
  }
  return false;
};
