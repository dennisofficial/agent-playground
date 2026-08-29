import type { EventOfType } from '../../events/envelope'

const OPEN = '<nudge>'
const CLOSE = '</nudge>'

export const nudgeBlock = (event: EventOfType<'nudge'>): string =>
  [OPEN, event.text, CLOSE].join('\n')
