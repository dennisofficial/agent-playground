/**
 * prompt-kit — the ONE home for Atlas's system prompts, assembled Claude-Code-style from small annotated
 * fragments (there are no whole-body prompts). Every system prompt is built by `renderAgentPrompt(agent, ctx)`
 * (pure) — the DI `PromptService.generate` just delegates to it after boot-loud validation.
 *
 * - `agent.ts` — the `Agent` audience enum + audience sets. `prompt-ctx.ts` — the `PromptCtx` a prompt gates on.
 * - `fragment.decorator.ts` — `@FragmentGroup`/`@Fragment` (a plain, Nest-free WeakMap-backed metadata layer).
 * - `groups/*.group.ts` — the topic-bucketed fragment methods. `conditions.ts` — reusable `@Fragment` gates.
 * - `assemble.ts` — the pure assembly core (`renderAgentPrompt` + `primeFragments`).
 * - `fragments.ts` — the shared TEXT catalog fragment methods cite. `job-kind.ts` — the job-kind block helper.
 * - `preview.ts` — the dev-only preview catalog. `prompt.service.ts`/`prompt-kit.module.ts` — the DI facade.
 * - `bodies/*.body.ts` — TRANSITIONAL persona-text consts the fragments wrap (being inlined + removed).
 */
// Shared TEXT catalog the fragment methods cite (`fragments.ts`) + the job-kind block helper (`job-kind.ts`).
export * from './fragments';
export * from './job-kind';

// ── The fragment library (Claude-Code-style assembly): the ONE assembler + the audience/context types. ──
export * from './agent';
export * from './prompt-ctx';
export * from './conditions';
export * from './fragment.decorator';
export * from './assemble';
export * from './prompt.service';
export * from './prompt-kit.module';
// Dev-only preview catalog (`GET /test/prompts`, `dump-prompts`).
export * from './preview';

// ── The SECOND category: self-contained, host-initiated one-shot turns (NOT assembled, NOT `Agent`s). ──
export * from './turns/turn';
export * from './turns/ship-open-pr';
export * from './turns/adr-promotion';
export * from './turns/build-handoff';
