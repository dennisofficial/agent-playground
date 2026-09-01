import { join } from 'node:path'

import { atlasDirectory } from '@dltech/atlas-harness'

export const PASTES_DIRECTORY_NAME = 'pastes'

/**
 * Pasted pictures live beside the event log rather than in the project, so a screenshot never turns
 * up as an untracked file in the repository the agent is working on.
 */
export const pasteDirectoryOf = (threadId: string): string =>
  join(atlasDirectory(), PASTES_DIRECTORY_NAME, threadId)
