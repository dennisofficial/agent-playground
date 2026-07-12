/**
 * PASSIVE pipeline-milestone awareness — the PURE half (signature / summary / prefix) now lives in the
 * zero-dep `prompt-kit` hub (see `../prompt-kit/harness/pipeline-awareness`), since it renders agent-facing
 * text. This file stays as a re-export shim so existing driver/brain imports (and this area's DURABLE half,
 * `./pipeline-awareness.store`) keep resolving without churn.
 */
export * from '../prompt-kit/harness/pipeline-awareness';
