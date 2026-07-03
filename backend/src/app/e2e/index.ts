/**
 * W9 — the end-to-end verification harness (`e2e`). Boots the real `AppModule` over the
 * agent-facing surface and drives the three plan scenarios (feature, notification event,
 * prompt-injection security), offline-deterministic by default and `--live` against a real repo.
 * Zero v1 imports.
 */
export * from './e2e-harness.service';
export {
  FakeClassifierLlm,
  FakeEngineRunner,
  FakeGithubPrService,
  FakeLocalGitService,
} from './e2e-stubs';
