import { resolve } from "path";
import { defineConfig } from "vitest/config";

// Pure unit tests only — no DOM, no Next.js runtime. `*.spec.ts` mirrors the backend's unit-test
// filename convention.
export default defineConfig({
  resolve: { alias: { "@": resolve(__dirname, "src") } },
  test: {
    globals: true,
    environment: "node",
    include: ["src/**/*.spec.ts"],
  },
});
