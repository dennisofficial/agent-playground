import { basename, dirname, extname } from 'node:path'

import { BUILT_IN_SKILLS } from './manifest.generated'
import {
  ESkillOrigin,
  isSkillEntryFilename,
  parseSkill,
  SkillSource,
  type DiscoveredSkill,
} from './skill'

const nameOf = (path: string): string => {
  const file = basename(path)
  if (isSkillEntryFilename(file)) return basename(dirname(path))
  return basename(file, extname(file))
}

export class EmbeddedSkillSource extends SkillSource {
  readonly origin = ESkillOrigin.BuiltIn

  async load(): Promise<readonly DiscoveredSkill[]> {
    return BUILT_IN_SKILLS.flatMap((entry) => {
      const skill = parseSkill({
        text: entry.text,
        fallbackName: nameOf(entry.path),
        origin: this.origin,
      })
      return skill === undefined ? [] : [skill]
    })
  }
}
