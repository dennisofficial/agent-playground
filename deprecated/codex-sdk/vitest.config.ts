import { defineConfig } from 'vitest/config';

// Pure unit tests — no real `codex app-server` binary. Framing/protocol tests spawn a small fake
// app-server (test/fixtures/fake-app-server.mjs) over real stdio so the JSON-RPC peer is exercised
// end-to-end without depending on the Codex CLI being installed.
export default defineConfig({
  test: {
    environment: 'node',
    include: ['src/**/*.spec.ts'],
    testTimeout: 10_000,
  },
});
