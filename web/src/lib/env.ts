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
 * Typed env for the admin web. The server/client boundary is enforced by t3-env,
 * so server-only values can never leak into the browser bundle; NEXT_PUBLIC_* vars
 * are inlined into the client bundle at build time.
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
    // The backend admin API base, as seen from the Next SERVER (reads/mutations are proxied
    // server-side; the browser never calls the backend directly).
    BACKEND_URL: z.url().default('http://localhost:4000'),
    // The admin bearer — server-only by construction (t3-env boundary). Unset → the admin UI
    // renders its setup card; it can never reach the client bundle.
    ADMIN_API_TOKEN: z.string().optional(),
    // Optional default Slack team id for the admin UI. When set the admin page loads this
    // workspace without requiring a ?team= query param. Can be overridden at any time via URL.
    ADMIN_TEAM_ID: z.string().optional(),
  },
  client: {
    NEXT_PUBLIC_APP_ENV: z.enum(EAppEnv).default(EAppEnv.LOCAL),
    // Base URL of the backend admin API.
    NEXT_PUBLIC_BACKEND_URL: z.url().default('http://localhost:4000'),
  },
  runtimeEnv: {
    NODE_ENV: process.env.NODE_ENV,
    BUILD_ID: process.env.BUILD_ID,
    BACKEND_URL: process.env.BACKEND_URL,
    ADMIN_API_TOKEN: process.env.ADMIN_API_TOKEN,
    ADMIN_TEAM_ID: process.env.ADMIN_TEAM_ID,
    NEXT_PUBLIC_APP_ENV: process.env.NEXT_PUBLIC_APP_ENV,
    NEXT_PUBLIC_BACKEND_URL: process.env.NEXT_PUBLIC_BACKEND_URL,
  },
});
