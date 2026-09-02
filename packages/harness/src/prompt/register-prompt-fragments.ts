import { PromptFragment } from '@dltech/atlas-core'

import { SkillRegistryPort } from '../skills/port'
import { instanceCachingFactory, portToken, type DependencyContainer } from '../container/injection'
import { DelegationFragment } from './fragments/agents'
import {
  ProjectDirectoryFragment,
  RelativePathsFragment,
  TodayFragment,
} from './fragments/environment'
import { ReadBeforeWriteFragment, ReadWideFragment } from './fragments/files'
import { AtlasIdentityFragment } from './fragments/identity'
import {
  CiteFileAndLineFragment,
  CutOrderFragment,
  LeadWithOutcomeFragment,
  OutputShapeFragment,
  ReadableBeatsTerseFragment,
} from './fragments/output'
import { TaskListFragment } from './fragments/plan'
import { DestructiveActionsFragment, GitEtiquetteFragment } from './fragments/safety'
import {
  ConcernThenBuildFragment,
  DeliverWhatWasAskedFragment,
  RequestLadderFragment,
} from './fragments/scope'
import { BackgroundShellsFragment } from './fragments/shells'
import { SkillListingFragment } from './fragments/skills'
import {
  NoRereadAfterWriteFragment,
  ParallelToolCallsFragment,
  PreferDedicatedToolsFragment,
} from './fragments/tools'
import { UntrustedWebContentFragment, WebResearchFragment } from './fragments/web'
import { CompactionNoticeFragment } from './fragments/workflow'
import { InMemoryPromptRegistry, PromptRegistry } from './registry'

export function registerBuiltinPromptFragments({
  container,
}: {
  container: DependencyContainer
}): void {
  const fragments = [
    AtlasIdentityFragment,
    CompactionNoticeFragment,
    RequestLadderFragment,
    DeliverWhatWasAskedFragment,
    ConcernThenBuildFragment,
    TodayFragment,
    ProjectDirectoryFragment,
    RelativePathsFragment,
    ReadBeforeWriteFragment,
    ReadWideFragment,
    PreferDedicatedToolsFragment,
    ParallelToolCallsFragment,
    NoRereadAfterWriteFragment,
    BackgroundShellsFragment,
    TaskListFragment,
    DelegationFragment,
    DestructiveActionsFragment,
    GitEtiquetteFragment,
    LeadWithOutcomeFragment,
    ReadableBeatsTerseFragment,
    OutputShapeFragment,
    CutOrderFragment,
    CiteFileAndLineFragment,
    SkillListingFragment,
    WebResearchFragment,
    UntrustedWebContentFragment,
  ]

  for (const fragment of fragments) {
    if (fragment === SkillListingFragment) {
      container.register(portToken(PromptFragment), {
        useFactory: (resolver) =>
          new SkillListingFragment(resolver.resolve(portToken(SkillRegistryPort))),
      })
      continue
    }
    container.register(portToken(PromptFragment), { useClass: fragment })
  }

  container.register(portToken(PromptRegistry), {
    useFactory: instanceCachingFactory(
      (resolver) => new InMemoryPromptRegistry(resolver.resolveAll(portToken(PromptFragment))),
    ),
  })
}
