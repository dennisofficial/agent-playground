import {
  EngineAuthError,
  HOST_TRANSPORT_TRANSIENT_RE,
  SDK_RETRY_EXHAUSTED_API_RE,
  isAuthErrorMessage,
  isSessionLimitError,
  isUnresumableSessionMessage,
} from './engine.types';
import { detectSessionLimitText } from './session-limit';

export type TurnFailureCategory =
  | 'session_limit'
  | 'auth'
  | 'transient'
  | 'api_overloaded'
  | 'sandbox_lost'
  | 'unresumable'
  | 'unknown';

export type TurnFailureSummary = {
  category: TurnFailureCategory;
  summary: string;
};

export function summarizeTurnFailure(err: unknown): TurnFailureSummary {
  const raw = err instanceof Error ? err.message : String(err); // ORIGINAL case — do not lowercase this
  if (isSessionLimitError(err) || detectSessionLimitText(raw)) {
    return {
      category: 'session_limit',
      summary: "You've hit your Claude session limit — it auto-resumes at reset.",
    };
  }
  if (err instanceof EngineAuthError || isAuthErrorMessage(raw)) {
    return {
      category: 'auth',
      summary: 'Your Claude login needs attention — reconnect it in Settings, then resume.',
    };
  }
  if (isUnresumableSessionMessage(raw)) {
    return {
      category: 'unresumable',
      summary: "This thread's engine session is gone — start a new thread to continue.",
    };
  }
  const m = raw.toLowerCase(); // only the regex checks below are case-insensitive-safe to run on lowercase
  if (SDK_RETRY_EXHAUSTED_API_RE.test(m)) {
    return {
      category: 'api_overloaded',
      summary: 'Claude was overloaded and the request kept failing — try again shortly.',
    };
  }
  if (HOST_TRANSPORT_TRANSIENT_RE.test(m)) {
    return {
      category: 'transient',
      summary: 'A temporary connection/infra hiccup interrupted the turn — retrying.',
    };
  }
  if (/no such container|presumed dead|no events/.test(m)) {
    return {
      category: 'sandbox_lost',
      summary: 'The sandbox for this job dropped — it will re-attach or can be resumed.',
    };
  }
  return {
    category: 'unknown',
    summary: 'The engine turn failed unexpectedly — see details, then resume.',
  };
}
