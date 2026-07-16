import type { NextConfig } from "next";
// Validate env at build time — fails fast if required vars are missing.
import "./src/lib/env";

// When the sandbox exposes this dev server through the atlas-svc preview proxy, the browser
// loads the app from `<preview-id>-web.<ATLAS_PREVIEW_DOMAIN>` — a foreign origin to the dev
// server, which otherwise blocks `/_next/*` assets + the HMR socket with a 403 and leaves the
// app stuck loading. Allow any preview service subdomain (one label under the preview domain).
const previewDomain = process.env.ATLAS_PREVIEW_DOMAIN;
const allowedDevOrigins = [previewDomain ? `*.${previewDomain}` : "*.preview.byatlas.io"];

const nextConfig: NextConfig = {
  reactCompiler: true,

  // Allow the dev server to serve HMR / `/_next` assets when the app is reached through its Atlas cloud
  // preview URL instead of localhost. Next blocks cross-origin dev requests by default; the preview
  // subdomains (`<preview-id>-web.<ATLAS_PREVIEW_DOMAIN>`) are trusted infra. Derived from the preview
  // domain so previews load regardless of which domain serves them (falling back to the default).
  allowedDevOrigins,

  // Transpile the workspace shared package (its runtime output is dist/, but Next
  // needs to compile the source it imports).
  transpilePackages: ["@workspace/shared"],

  // No proxy: the browser talks to the Atlas HTTP app DIRECTLY at NEXT_PUBLIC_HTTP_URL
  // (`/web/*` REST, `/web/events` SSE, `/auth/*`) with credentialed CORS. See src/lib/env.ts.

  // Standalone output bundles the minimal Node.js server + required node_modules into
  // .next/standalone/ so the production Docker image needs no pnpm install at runtime.
  // Required by infra/web.Dockerfile.
  output: "standalone",
};

export default nextConfig;
