/**
 * W9 — the end-to-end verification harness (`atlas:e2e`). Boots the real `AtlasModule` over the
 * agent-facing surface and drives the three plan scenarios (feature, autonomous notification,
 * prompt-injection security), offline-deterministic by default and `--live` against a real repo.
 * Zero v1 imports.
 */
export * from './e2e-harness.service';
export {
  FakeBrainLlm,
  FakeClassifierLlm,
  FakeEngineRunner,
  FakeGithubPrService,
  FakeLocalGitService,
  FakePlannerLlm,
} from './e2e-stubs';
