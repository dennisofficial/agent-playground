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
 * Typed env for the Atlas web operator console.
 *
 * The browser talks to the Atlas HTTP app DIRECTLY (no Next.js proxy hop) — `/web/*` REST, the `/web/events`
 * SSE stream, and `/auth/*` all hit `NEXT_PUBLIC_HTTP_URL` with credentials. That URL is therefore a
 * CLIENT var (it reaches the browser bundle), and the Atlas app enables credentialed CORS for our origin.
 * Defaults let the app boot locally with no .env files; real values come from .env.local.enc / .env.personal
 * via the `env:inject` script.
 */
export const env = createEnv({
  emptyStringAsUndefined: true,
  shared: {
    // Provided by Next.js (dev/build). Never set NODE_ENV in a dotenv file.
    NODE_ENV: z.enum(ENodeEnv),
  },
  server: {
    BUILD_ID: z.string().default('dev'),
  },
  client: {
    NEXT_PUBLIC_APP_ENV: z.enum(EAppEnv),
    NEXT_PUBLIC_BACKEND_URL: z.url(),
    NEXT_PUBLIC_GIT_SHA: z.string().default('dev'),
  },
  runtimeEnv: {
    NODE_ENV: process.env.NODE_ENV,
    BUILD_ID: process.env.BUILD_ID,
    NEXT_PUBLIC_APP_ENV: process.env.NEXT_PUBLIC_APP_ENV,
    NEXT_PUBLIC_BACKEND_URL: process.env.NEXT_PUBLIC_BACKEND_URL,
    NEXT_PUBLIC_GIT_SHA: process.env.NEXT_PUBLIC_GIT_SHA,
  },
});
