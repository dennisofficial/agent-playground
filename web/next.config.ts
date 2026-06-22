import type { NextConfig } from "next";
// Validate env at build time — fails fast if required vars are missing.
import "./src/lib/env";

const nextConfig: NextConfig = {
  reactCompiler: true,
  // Transpile the workspace shared package (its runtime output is dist/, but Next
  // needs to compile the source it imports).
  transpilePackages: ["@workspace/shared"],

  // No proxy: the browser talks to the Atlas HTTP app DIRECTLY at NEXT_PUBLIC_ATLAS_HTTP_URL
  // (`/web/*` REST, `/web/events` SSE, `/auth/*`) with credentialed CORS. See src/lib/env.ts.
};

export default nextConfig;
