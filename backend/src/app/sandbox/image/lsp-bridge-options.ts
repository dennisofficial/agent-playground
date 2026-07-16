/**
 * Moved to `src/engine/transport/bridges/lsp-bridge-options.ts` (the in-container engine app owns the
 * turn's bridge option assembly now). This re-export keeps the in-image `engine-entrypoint.ts` importer
 * compiling until it is removed in a later thread.
 */
export * from '../../../engine/transport/bridges/lsp-bridge-options';
