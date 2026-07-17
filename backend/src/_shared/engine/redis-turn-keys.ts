export const turnKeys = (turnId: string) => ({
  spec: `turn:${turnId}:spec`,
  events: `turn:${turnId}:events`,
  tools: `turn:${turnId}:tools`,
  replies: `turn:${turnId}:replies`,
  abort: `turn:${turnId}:abort`,
  input: `turn:${turnId}:input`,
});

export const TOOLS_GROUP = 'host';

export const EVENTS_RUNNER_GROUP = 'runner';
export const EVENTS_REALTIME_GROUP = 'realtime';
export const EVENTS_WATCHDOG_GROUP = 'watchdog';
