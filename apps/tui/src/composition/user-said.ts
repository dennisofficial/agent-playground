import type { EventDraft } from '@dltech/atlas-core'

import type { PendingSaid } from '../store'

export const userSaidDraft = (said: PendingSaid): EventDraft => ({
  type: 'user-said',
  text: said.text,
  ...(said.images.length === 0 ? {} : { images: said.images }),
})
