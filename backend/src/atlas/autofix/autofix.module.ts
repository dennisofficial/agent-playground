import { Module } from '@nestjs/common';
import { EngineModule } from '../engine';
import { GitModule } from '../git';
import { AutoFixStage } from './autofix.stage';

/**
 * W7 — the AUTO-FIX STAGE module. Provides the `AutoFixStage` (per-section + PR-tail fan-out review →
 * dedupe → fix → commit) for W4's driver to call. Composes ONLY W1's substrate: the `EngineRunner`
 * (review + fix turns) and `LocalGitService` (the fix commit). No persistence of its own — the stage
 * is stateless; the driver owns recording the returned `AutoFixSummary`.
 *
 * Zero imports from `harness/**` or the v1 `slack-app` surface.
 */
@Module({
  imports: [EngineModule, GitModule],
  providers: [AutoFixStage],
  exports: [AutoFixStage],
})
export class AutoFixModule {}
