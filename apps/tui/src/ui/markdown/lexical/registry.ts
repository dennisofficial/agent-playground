import { infoStringToFiletype } from '@opentui/core'

import { LEXICAL_LANGUAGES } from './languages/index'
import { createScanner, type Scanner } from './scanner'
import type { LanguageSpec } from './spec'

const specsByKey = new Map<string, LanguageSpec>()
const scannersByFiletype = new Map<string, Scanner>()

for (const spec of LEXICAL_LANGUAGES) {
  for (const key of [spec.filetype, ...(spec.aliases ?? [])]) {
    const claimed = specsByKey.get(key)
    if (claimed) throw new Error(`lexical language "${key}" claimed by both ${claimed.filetype} and ${spec.filetype}`)
    specsByKey.set(key, spec)
  }
}

export function lexicalKeys(): readonly string[] {
  return [...specsByKey.keys()]
}

export function lexicalSpecFor(language: string): LanguageSpec | null {
  const lowered = language.toLowerCase()
  const direct = specsByKey.get(lowered)
  if (direct) return direct

  const filetype = infoStringToFiletype(lowered)
  if (!filetype) return null

  return specsByKey.get(filetype) ?? null
}

export function lexicalScannerFor(language: string): Scanner | null {
  const spec = lexicalSpecFor(language)
  if (!spec) return null

  const cached = scannersByFiletype.get(spec.filetype)
  if (cached) return cached

  const built = createScanner(spec)
  scannersByFiletype.set(spec.filetype, built)
  return built
}
