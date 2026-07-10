import type { NextConfig } from "next";
// Validate env at build time — fails fast if required vars are missing.
import "./src/lib/env";

const nextConfig: NextConfig = {
  reactCompiler: true,
  // Transpile the workspace shared package (its runtime output is dist/, but Next
  // needs to compile the source it imports).
  transpilePackages: ["@workspace/shared"],

  // No proxy: the browser talks to the Atlas HTTP app DIRECTLY at NEXT_PUBLIC_HTTP_URL
  // (`/web/*` REST, `/web/events` SSE, `/auth/*`) with credentialed CORS. See src/lib/env.ts.

  // Allow the dev server to serve HMR / `/_next` assets when the app is reached through its Atlas cloud
  // preview URL instead of localhost. Next blocks cross-origin dev requests by default; the preview
  // subdomains (`<id>-web.atlas.dltechnologies.co`) are trusted infra.
  allowedDevOrigins: ["*.atlas.dltechnologies.co"],

  // Standalone output bundles the minimal Node.js server + required node_modules into
  // .next/standalone/ so the production Docker image needs no pnpm install at runtime.
  // Required by infra/web.Dockerfile.
  output: "standalone",
};

export default nextConfig;
