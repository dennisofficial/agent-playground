import { addDefaultParsers } from '@opentui/core'

import { getParsers } from './parsers.generated'

export async function registerGrammars(): Promise<void> {
  addDefaultParsers(await getParsers())
}
