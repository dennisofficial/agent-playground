/**
 * Moved to `src/engine/transport/bridges/tool-bridge-reader.ts` (the in-container engine app owns the
 * tool-bridge transport now). This re-export keeps the in-image `engine-entrypoint.ts` and
 * `mcp-bridge-server.ts` importers compiling until they are ported/removed in a later thread.
 */
export * from '../../../engine/transport/bridges/tool-bridge-reader';
