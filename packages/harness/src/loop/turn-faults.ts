import type { CallId, ExchangeFault } from '@dltech/atlas-core'

const faultLine = (fault: ExchangeFault): string =>
  `message ${fault.messageIndex}: ${fault.detail} (event ${fault.origin.eventId})`

export const stalledReport = (call: { callId: CallId; name: string }): string =>
  `dispatch left ${call.name} (${call.callId}) pending without settling it — the turn would spin forever`

export const faultReport = (faults: readonly ExchangeFault[]): string =>
  `the assembled prompt is one Atlas must not send — ${faults.map(faultLine).join('; ')}`
