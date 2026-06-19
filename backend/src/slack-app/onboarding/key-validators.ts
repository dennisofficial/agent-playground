/**
 * Provider key/token FORMAT validators — shared by the onboarding keys modal (first-time setup) and
 * the rotate-keys modal (in-place rotation). Format-only sanity checks; the real test is the next
 * live call. Kept here (not private to one service) so both modals validate identically.
 */

/** Anthropic API key — `sk-ant-…`. */
export const ANTHROPIC_KEY = /^sk-ant-[\w-]{8,}$/;
/** OpenAI API key — `sk-…` (covers `sk-proj-…` too). */
export const OPENAI_KEY = /^sk-[\w-]{8,}$/;
/** GitHub token — permissive: classic 40-hex PATs, `ghp_…`, `github_pat_…`; just refuse whitespace/shorties. */
export const GITHUB_TOKEN = /^\S{20,}$/;
