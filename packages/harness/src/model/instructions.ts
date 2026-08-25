import type { SystemModelMessage } from 'ai'

import type { SystemBlock } from '@dltech/atlas-core'

import { carriedProviderOptions } from './provider-options'

export const toInstructions = (blocks: readonly SystemBlock[]): SystemModelMessage[] =>
  blocks.map((block) => ({
    role: 'system',
    content: block.text,
    ...carriedProviderOptions(block.providerOptions),
  }))
