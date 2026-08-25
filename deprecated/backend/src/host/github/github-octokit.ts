import type { Logger } from '@nestjs/common';

/** Bounded automatic retries when GitHub rate-limits us; beyond that we surface the error to the caller. */
const MAX_THROTTLE_RETRIES = 2;

type ThrottleReqOptions = { method: string; url: string };

export function throttleOptions(logger: Logger) {
  return {
    onRateLimit(
      retryAfter: number,
      options: ThrottleReqOptions,
      _octokit: unknown,
      retryCount: number,
    ) {
      logger.warn(
        `GitHub rate limit on ${options.method} ${options.url} — retry ${retryCount} in ${retryAfter}s`,
      );
      return retryCount < MAX_THROTTLE_RETRIES;
    },
    onSecondaryRateLimit(
      retryAfter: number,
      options: ThrottleReqOptions,
      _octokit: unknown,
      retryCount: number,
    ) {
      logger.warn(
        `GitHub secondary rate limit on ${options.method} ${options.url} — retry ${retryCount} in ${retryAfter}s`,
      );
      return retryCount < MAX_THROTTLE_RETRIES;
    },
  };
}
