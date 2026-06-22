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
 * Auth mode for the Atlas console.
 *  - `stub`  → the flip-ready localStorage stub (no backend `/auth/*` yet — the default today).
 *  - `real`  → the real `@workspace/auth` cookie session against `/auth/*` (when the backend lands).
 */
export enum EAuthMode {
  STUB = 'stub',
  REAL = 'real',
}

/**
 * Typed env for the Atlas web operator console.
 *
 * The browser always talks to the Atlas web surface SAME-ORIGIN (`/web/*`), which `next.config.ts`
 * rewrites (and `app/web/events/route.ts` streams) to the Atlas HTTP app. So the backend URL is a
 * SERVER-only var (`ATLAS_HTTP_URL`) — it never reaches the client bundle and there is no CORS to
 * configure. Defaults let the app boot locally with no .env files; real values come from
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
    // Where the Atlas standalone HTTP app (ATLAS_SURFACE=web) listens. Proxied, never sent to the client.
    ATLAS_HTTP_URL: z.url().default('http://localhost:4002'),
  },
  client: {
    NEXT_PUBLIC_APP_ENV: z.enum(EAppEnv).default(EAppEnv.LOCAL),
    // Auth implementation toggle — flip to `real` once the backend ships `/auth/*` (see BACKEND_GAPS.md).
    NEXT_PUBLIC_AUTH_MODE: z.enum(EAuthMode).default(EAuthMode.STUB),
  },
  runtimeEnv: {
    NODE_ENV: process.env.NODE_ENV,
    BUILD_ID: process.env.BUILD_ID,
    ATLAS_HTTP_URL: process.env.ATLAS_HTTP_URL,
    NEXT_PUBLIC_APP_ENV: process.env.NEXT_PUBLIC_APP_ENV,
    NEXT_PUBLIC_AUTH_MODE: process.env.NEXT_PUBLIC_AUTH_MODE,
  },
});
