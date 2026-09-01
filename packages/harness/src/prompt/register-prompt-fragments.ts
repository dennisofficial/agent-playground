import { PromptFragment } from '@dltech/atlas-core'

import { instanceCachingFactory, portToken, type DependencyContainer } from '../container/injection'
import { ProjectDirectoryFragment, RelativePathsFragment } from './fragments/environment'
import { ReadBeforeWriteFragment } from './fragments/files'
import { AtlasIdentityFragment } from './fragments/identity'
import { SkillListingFragment } from './fragments/skills'
import { CompactionNoticeFragment } from './fragments/workflow'
import { InMemoryPromptRegistry, PromptRegistry } from './registry'

export function registerBuiltinPromptFragments({
  container,
}: {
  container: DependencyContainer
}): void {
  container.register(portToken(PromptFragment), { useClass: AtlasIdentityFragment })
  container.register(portToken(PromptFragment), { useClass: CompactionNoticeFragment })
  container.register(portToken(PromptFragment), { useClass: ProjectDirectoryFragment })
  container.register(portToken(PromptFragment), { useClass: RelativePathsFragment })
  container.register(portToken(PromptFragment), { useClass: ReadBeforeWriteFragment })
  container.register(portToken(PromptFragment), { useClass: SkillListingFragment })

  container.register(portToken(PromptRegistry), {
    useFactory: instanceCachingFactory((resolver) => resolver.resolve(InMemoryPromptRegistry)),
  })
}
