/**
 * PASSIVE pipeline-milestone awareness — the PURE half (signature / summary / prefix) lives in the zero-dep
 * `prompt-kit` hub (see `../prompt-kit/harness/pipeline-awareness`), since it renders agent-facing text.
 * This file stays as a re-export shim so existing driver imports keep resolving without churn.
 */
export * from '../prompt-kit/harness/pipeline-awareness';
