import type { NextConfig } from "next";
// Validate env at build time — fails fast if required vars are missing.
import { env } from "./src/lib/env";

const nextConfig: NextConfig = {
  reactCompiler: true,
  // Transpile the workspace shared package (its runtime output is dist/, but Next
  // needs to compile the source it imports).
  transpilePackages: ["@workspace/shared"],

  // Same-origin proxy to the Atlas web surface (ATLAS_SURFACE=web on ATLAS_HTTP_URL).
  // The browser only ever talks to `/web/*` on this origin, so there is no CORS to configure.
  //
  // `afterFiles` runs AFTER the filesystem routes, so `app/web/events/route.ts` keeps ownership of
  // the SSE stream (it pipes the upstream `text/event-stream` body unbuffered); every other `/web/*`
  // REST call falls through to this rewrite and is proxied to the Atlas HTTP app.
  async rewrites() {
    return {
      beforeFiles: [],
      afterFiles: [
        {
          source: "/web/:path*",
          destination: `${env.ATLAS_HTTP_URL}/web/:path*`,
        },
      ],
      fallback: [],
    };
  },
};

export default nextConfig;
