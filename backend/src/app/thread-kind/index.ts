/**
 * thread-kind — the "add a thread kind" seam. One `ThreadKindSpec` per kind binds a `threads.kind` row to
 * its prompt-kit `Agent`, engine, driver mode, lane, gates, and children. Boot-validated like prompt-kit.
 */
export * from '@shared/thread-kind/thread-types';
export * from './registry';
export * from './spec';
export { ThreadKindModule } from './thread-kind.module';
export { ThreadKindRegistry } from './thread-kind.service';
