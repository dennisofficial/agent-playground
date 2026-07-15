/**
 * stage-kind — the "add a stage kind" seam. One `StageKindSpec` per kind declares the roles a stage of
 * that kind contains, whether it reviews, whether it needs a title, and the orchestration seam it spawns
 * at (d2/d7/d8). Boot-validated like `thread-kind`.
 */
export * from './spec';
export * from './registry';
export { StageKindRegistry } from './stage-kind.service';
export { StageKindModule } from './stage-kind.module';
