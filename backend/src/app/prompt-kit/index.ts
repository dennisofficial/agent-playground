/**
 * prompt-kit — the ONE home for Atlas's system prompts, assembled Claude-Code-style from small annotated
 * fragments (there are no whole-body prompts). Every system prompt is built by `renderAgentPrompt(agent, ctx)`
 * (pure) — the DI `PromptService.generate` just delegates to it after boot-loud validation.
 *
 * - `system/agent.ts` — the `Agent` audience enum + audience sets. `system/prompt-ctx.ts` — the `PromptCtx`
 *   a prompt gates on.
 * - `system/fragment.decorator.ts` — `@FragmentGroup`/`@Fragment` (a plain, Nest-free WeakMap-backed metadata
 *   layer).
 * - `system/groups/*.group.ts` — the topic-bucketed fragment methods. `system/conditions.ts` — reusable
 *   `@Fragment` gates.
 * - `system/assemble.ts` — the pure assembly core (`renderAgentPrompt` + `primeFragments`).
 * - `system/fragments.ts` — the shared TEXT catalog fragment methods cite. `system/job-kind.ts` — the
 *   job-kind block helper.
 * - `system/preview.ts` — the dev-only preview catalog. `prompt.service.ts`/`prompt-kit.module.ts` — the DI
 *   facade.
 */
// Pillar 1: the @Fragment/@FragmentGroup system-prompt library (assembler, TEXT catalog, audience/context
// types, conditions, dev-only preview).
export * from '@shared/prompt-kit/system';
export * from '@shared/prompt-kit/message';
export * from './prompt.service';
export * from './prompt-kit.module';

// ── The SECOND category: user-message / task-body templates, plus self-contained, host-initiated one-shot
// turns (NOT assembled, NOT `Agent`s) — both now live under `messages/`. ──
export * from './messages';
