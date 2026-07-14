import { defineConfig } from 'vitest/config';

// Pure unit tests for the engine port, capability sets, and the vendor-agnostic leaf types.
export default defineConfig({
  test: {
    environment: 'node',
    include: ['src/**/*.spec.ts'],
    testTimeout: 10_000,
  },
});
