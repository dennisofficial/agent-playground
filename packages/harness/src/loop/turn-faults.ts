import type { CallId, ExchangeFault } from '@dltech/atlas-core'

const faultLine = (fault: ExchangeFault): string =>
  `message ${fault.messageIndex}: ${fault.detail} (event ${fault.origin.eventId})`

export const stalledReport = (call: { callId: CallId; name: string }): string =>
  `dispatch left ${call.name} (${call.callId}) pending without settling it — the turn would spin forever`

export const swallowedReport = (call: { callId: CallId; name: string }): string =>
  `the turn called ${call.name} (${call.callId}) but the log no longer holds that call as pending, so it never ran — this is a harness bug, not something the model decided`

export const faultReport = (faults: readonly ExchangeFault[]): string =>
  `the assembled prompt is one Atlas must not send — ${faults.map(faultLine).join('; ')}`

export const overflowReport = ({ tokens, window }: { tokens: number; window: number }): string =>
  `this conversation no longer fits the model's context window — about ${tokens.toLocaleString('en-US')} tokens against ${window.toLocaleString('en-US')}. Run /compact to replace the older turns with a summary, or raise the automatic threshold in settings.`
