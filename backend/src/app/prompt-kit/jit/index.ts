/**
 * prompt-kit / jit — Pillar 4: the JIT context registry (declarative rule catalog, d1/d4/d5).
 *
 * A pure catalog of trigger·threshold·delivery·payload rules consumed by two thin executors (engine-local +
 * host-side). Zero-dep and container-safe like the rest of the hub.
 */
export * from './rule';
export * from './rules';
export * from './svc-nudge';
export * from './install-awareness';
export * from './bg-task-cap';
export * from './plan-approved';
export * from './memory-recall';
