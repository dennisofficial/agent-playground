/**
 * thread-group-kind — the "add a thread-group kind" seam. One `ThreadGroupKindSpec` per kind declares the
 * roles a thread group of that kind contains, whether it reviews, whether it needs a title, and the
 * orchestration seam it spawns at (d2/d7/d8). Boot-validated like `thread-kind`.
 */
export * from './registry';
export * from './spec';
export { ThreadGroupKindModule } from './thread-group-kind.module';
export { ThreadGroupKindRegistry } from './thread-group-kind.service';
