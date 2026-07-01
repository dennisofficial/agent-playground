import { Module } from '@nestjs/common';
import { EngineModule } from '../engine';
import { GitModule } from '../git';
import { AutoFixStage } from './autofix.stage';

/**
 * W7 — the AUTO-FIX STAGE module. Provides the `AutoFixStage` (per-thread + PR-tail fan-out review →
 * dedupe → fix → commit) for W4's driver to call. Composes W1's substrate — the `EngineRunner` (review +
 * fix turns) and `LocalGitService` (the fix commit) — plus the @Global `TurnHarnessFactory` (the shared
 * transcript spine; no import needed, hence not listed here) so the review lenses + fix turn stream like
 * every other agent turn. No persistence of its own — the stage is stateless; the driver owns recording
 * the returned `AutoFixSummary` and emitting the `autofix_anchor` row.
 *
 * Zero imports from the v1 `slack-app` surface.
 */
@Module({
  imports: [EngineModule, GitModule],
  providers: [AutoFixStage],
  exports: [AutoFixStage],
})
export class AutoFixModule {}
