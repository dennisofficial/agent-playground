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
 * Typed env for the admin web. Server-side requests use ADMIN_API_TOKEN + BACKEND_URL;
 * the browser never holds either value. NEXT_PUBLIC_* vars are inlined into the client
 * bundle at build time.
 *
 * Tenant identity comes from the ?team= URL search param at runtime, not an env var —
 * the same portal binary serves every workspace without a redeploy. ADMIN_TEAM_ID is an
 * optional server-side default that pre-fills the workspace on first visit.
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
    // Backend admin API bearer — must match backend ADMIN_API_TOKEN. Never exposed to client.
    ADMIN_API_TOKEN: z.string().optional(),
    // Backend base URL for server-side fetches (no NEXT_PUBLIC_ prefix — stays on server).
    BACKEND_URL: z.string().url().default('http://localhost:4000'),
    // Optional default Slack team ID; pre-fills the workspace picker on first visit.
    ADMIN_TEAM_ID: z.string().optional(),
  },
  client: {
    NEXT_PUBLIC_APP_ENV: z.enum(EAppEnv).default(EAppEnv.LOCAL),
    // Base URL of the backend admin API for any remaining client-side uses.
    NEXT_PUBLIC_BACKEND_URL: z.url().default('http://localhost:4000'),
  },
  runtimeEnv: {
    NODE_ENV: process.env.NODE_ENV,
    BUILD_ID: process.env.BUILD_ID,
    ADMIN_API_TOKEN: process.env.ADMIN_API_TOKEN,
    BACKEND_URL: process.env.BACKEND_URL,
    ADMIN_TEAM_ID: process.env.ADMIN_TEAM_ID,
    NEXT_PUBLIC_APP_ENV: process.env.NEXT_PUBLIC_APP_ENV,
    NEXT_PUBLIC_BACKEND_URL: process.env.NEXT_PUBLIC_BACKEND_URL,
  },
});
