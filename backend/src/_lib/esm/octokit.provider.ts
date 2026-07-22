import type { Provider } from '@nestjs/common';
import type { createAppAuth as CreateAppAuth } from '@octokit/auth-app';
import type { RequestError as RequestErrorClass } from '@octokit/request-error';
import type { Octokit } from '@octokit/rest';

export const OCTOKIT_SDK = Symbol('OCTOKIT_SDK');

/** Options we actually pass — base Octokit options plus the plugin/strategy fields (typed loosely). */
export interface AtlasOctokitOptions {
  auth?: unknown;
  authStrategy?: unknown;
  userAgent?: string;
  throttle?: unknown;
  request?: { fetch?: unknown };
}

/** The Octokit surface Atlas uses, resolved from the ESM packages at runtime. */
export interface OctokitSdk {
  /** Octokit pre-composed with the retry + throttling plugins — the one client build the app uses. */
  AtlasOctokit: new (options?: AtlasOctokitOptions) => InstanceType<typeof Octokit>;
  createAppAuth: typeof CreateAppAuth;
  RequestError: typeof RequestErrorClass;
}

export const OCTOKIT_SDK_PROVIDER: Provider = {
  provide: OCTOKIT_SDK,
  useFactory: async (): Promise<OctokitSdk> => {
    const [rest, retryPlugin, throttlingPlugin, authApp, requestError] = await Promise.all([
      import('@octokit/rest'),
      import('@octokit/plugin-retry'),
      import('@octokit/plugin-throttling'),
      import('@octokit/auth-app'),
      import('@octokit/request-error'),
    ]);
    return {
      AtlasOctokit: rest.Octokit.plugin(
        retryPlugin.retry,
        throttlingPlugin.throttling,
      ) as OctokitSdk['AtlasOctokit'],
      createAppAuth: authApp.createAppAuth,
      RequestError: requestError.RequestError,
    };
  },
};
