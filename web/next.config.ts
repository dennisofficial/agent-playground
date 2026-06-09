import type { NextConfig } from "next";
// Validate env at build time — fails fast if required vars are missing.
import "./src/lib/env";

const nextConfig: NextConfig = {
  reactCompiler: true,
  // Transpile the workspace shared package (its runtime output is dist/, but Next
  // needs to compile the source it imports).
  transpilePackages: ["@workspace/shared"],
};

export default nextConfig;
