import { createEnv } from '@t3-oss/env-nextjs';
import { z } from 'zod';

export enum ENodeEnv {
  DEV = 'development',
  PROD = 'production',
  TEST = 'test',
}

export enum EAppEnv {
  LOCAL = 'local',
  STAGING = 'staging',
  PROD = 'production',
}

/**
 * Typed env for the admin web. Auth is handled client-side via an httpOnly cookie;
 * NEXT_PUBLIC_* vars are inlined into the client bundle at build time.
 *
 * Tenant identity comes from the ?team= URL search param at runtime, not an env var —
 * the same portal binary serves every workspace without a redeploy.
 *
 * Defaults let the app boot locally with no .env files; real values come from
 * .env.local.enc / .env.personal via the `env:inject` script.
 */
export const env = createEnv({
  emptyStringAsUndefined: true,
  shared: {
    // Provided by Next.js (dev/build). Never set NODE_ENV in a dotenv file.
    NODE_ENV: z.enum(ENodeEnv).default(ENodeEnv.DEV),
  },
  server: {
    BUILD_ID: z.string().default('dev'),
  },
  client: {
    NEXT_PUBLIC_APP_ENV: z.enum(EAppEnv).default(EAppEnv.LOCAL),
    // Base URL of the backend admin API for any remaining client-side uses.
    NEXT_PUBLIC_BACKEND_URL: z.url().default('http://localhost:4000'),
  },
  runtimeEnv: {
    NODE_ENV: process.env.NODE_ENV,
    BUILD_ID: process.env.BUILD_ID,
    NEXT_PUBLIC_APP_ENV: process.env.NEXT_PUBLIC_APP_ENV,
    NEXT_PUBLIC_BACKEND_URL: process.env.NEXT_PUBLIC_BACKEND_URL,
  },
});
