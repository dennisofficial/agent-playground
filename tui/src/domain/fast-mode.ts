/**
 * Why fast mode is not serving, in a sentence rather than an enum.
 *
 * The SDK reports a code (`preference`, `extra_usage_disabled`, …) and the Claude Code CLI turns the
 * same codes into sentences for its own UI. Atlas printed the code, which told a human that fast
 * mode was "unavailable · preference" — true, unactionable, and not even in the right vocabulary:
 * `preference` is not the user's preference, it is the ORGANISATION having switched it off.
 *
 * Wordings follow the CLI's so the two do not contradict each other in front of the same person.
 * Unknown codes fall through to the code itself: a new reason should read oddly, not vanish.
 */
const REASONS: Record<string, string> = {
  free: 'requires a paid subscription',
  preference: 'disabled by your organization',
  extra_usage_disabled: 'requires usage credits',
  network_error: 'unavailable — network trouble',
  not_first_party: 'only available on the Anthropic API directly',
  disabled_by_env: 'not available in this environment',
  model_not_allowed: 'not supported by this model',
  sdk_opt_in_required: 'not requested for this session',
  pending: 'still being set up',
  unknown: 'currently unavailable',
};

export function fastModeNotice(args: {
  state: 'off' | 'cooldown' | 'on';
  disabledReason?: string | undefined;
}): string | null {
  // Nothing to say when it is working — the speed is its own evidence.
  if (args.state === 'on') return null;
  // Not a refusal: the run was rate-limited and fast mode stands down until the window turns over.
  if (args.state === 'cooldown') return 'fast mode paused until the rate limit clears';
  const reason = args.disabledReason ?? 'unknown';
  return `fast mode ${REASONS[reason] ?? `unavailable · ${reason}`}`;
}
