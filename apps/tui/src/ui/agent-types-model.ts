import { EDefinitionOrigin } from '@dltech/atlas-core'
import {
  EAgentTypeRefusal,
  type AgentType,
  type AgentTypeCatalog,
  type AgentTypeRefusal,
  type ShadowedAgentType,
} from '@dltech/atlas-harness'

export type AgentTypeRow = {
  name: string
  detail: string
  definedIn: string | null
}

export enum EAgentTypeSection {
  Loaded = 'loaded',
  Refused = 'refused',
  Shadowed = 'shadowed',
}

export type AgentTypeSection = {
  kind: EAgentTypeSection
  title: string
  rows: readonly AgentTypeRow[]
}

export const NOTHING_ON_DISK =
  'no agent type is defined anywhere — write one in .atlas/agents or ~/.atlas/agents'

const ORIGIN_LABEL: Record<EDefinitionOrigin, string> = {
  [EDefinitionOrigin.BuiltIn]: 'built in',
  [EDefinitionOrigin.User]: 'user',
  [EDefinitionOrigin.Project]: 'project',
}

/**
 * The category, which says which part of the file to look at. `detail` already quotes the offending
 * value, so the two are shown together rather than one standing in for the other.
 */
const REFUSAL_LABEL: Record<EAgentTypeRefusal, string> = {
  [EAgentTypeRefusal.Empty]: 'the file is empty',
  [EAgentTypeRefusal.BadName]: 'the name cannot be used',
  [EAgentTypeRefusal.NoDescription]: 'no description, so nothing says when to use it',
  [EAgentTypeRefusal.NoPrompt]: 'no prompt under the front matter',
  [EAgentTypeRefusal.BadMaxEffect]: 'the max effect is not one of the effects',
  [EAgentTypeRefusal.UnusableModel]: 'the model it asks for cannot be reached',
  [EAgentTypeRefusal.Unreadable]: 'the file could not be read',
}

const UNNAMED = 'unnamed'

const oneLine = (text: string): string => text.replace(/\s+/g, ' ').trim()

const named = (name: string | undefined): string => {
  const written = name === undefined ? '' : oneLine(name)
  return written === '' ? UNNAMED : written
}

export const originLabel = (origin: EDefinitionOrigin): string => ORIGIN_LABEL[origin]

export const refusalLabel = (refusal: EAgentTypeRefusal): string => REFUSAL_LABEL[refusal]

const loadedRow = (agentType: AgentType): AgentTypeRow => ({
  name: agentType.name,
  detail: `${ORIGIN_LABEL[agentType.origin]} · ${oneLine(agentType.whenToUse)}`,
  definedIn: agentType.definedIn ?? null,
})

/**
 * The category and the quoted value both survive, because between them they say which line of the
 * file is wrong and what it currently reads.
 */
const refusedRow = (refusal: AgentTypeRefusal): AgentTypeRow => ({
  name: named(refusal.name),
  detail: `${REFUSAL_LABEL[refusal.refusal]} — ${oneLine(refusal.detail)}`,
  definedIn: refusal.definedIn ?? null,
})

/**
 * Names what displaced it, not merely that something did: the operator's next move is to open the
 * file that won, and the origin is what tells them which of the two they are looking at.
 */
const shadowedRow = (shadowed: ShadowedAgentType): AgentTypeRow => ({
  name: shadowed.name,
  detail: `the ${ORIGIN_LABEL[shadowed.origin]} definition is unused — the ${ORIGIN_LABEL[shadowed.shadowedBy]} one is loaded instead`,
  definedIn: shadowed.definedIn ?? null,
})

/**
 * The two failures lead, because a working list is only reassuring while the missing entry is the
 * thing the operator came to find out about.
 */
export function agentTypeSections(catalog: AgentTypeCatalog): readonly AgentTypeSection[] {
  const sections: AgentTypeSection[] = []

  if (catalog.refusals.length > 0) {
    sections.push({
      kind: EAgentTypeSection.Refused,
      title: 'Not loaded',
      rows: catalog.refusals.map(refusedRow),
    })
  }

  if (catalog.shadowed.length > 0) {
    sections.push({
      kind: EAgentTypeSection.Shadowed,
      title: 'Shadowed',
      rows: catalog.shadowed.map(shadowedRow),
    })
  }

  if (catalog.types.length > 0) {
    sections.push({
      kind: EAgentTypeSection.Loaded,
      title: 'Loaded',
      rows: catalog.types.map(loadedRow),
    })
  }

  return sections
}

export const agentTypeCount = (catalog: AgentTypeCatalog): string =>
  `${catalog.types.length} loaded, ${catalog.refusals.length} refused, ${catalog.shadowed.length} shadowed`

export const catalogIsEmpty = (catalog: AgentTypeCatalog): boolean =>
  catalog.types.length === 0 && catalog.refusals.length === 0 && catalog.shadowed.length === 0
