import {
  definitionsOfPage,
  SETTING_PAGES,
  type ResolvedSetting,
  type SettingDefinition,
  type SettingPage,
  type SettingsResolution,
} from '@dltech/atlas-core'

export type SettingsGroup = {
  label: string
  rows: readonly ResolvedSetting[]
}

export type SettingsPageModel = {
  page: SettingPage
  groups: readonly SettingsGroup[]
  rows: readonly ResolvedSetting[]
}

export type SettingsModel = {
  pages: readonly SettingsPageModel[]
}

export type SettingsState = {
  pageIndex: number
  rowIndex: number
}

const wrapped = (args: { index: number; length: number }): number => {
  if (args.length === 0) return 0
  return ((args.index % args.length) + args.length) % args.length
}

const clamped = (args: { index: number; length: number }): number =>
  Math.min(Math.max(0, args.index), Math.max(0, args.length - 1))

const groupsOf = (rows: readonly ResolvedSetting[]): readonly SettingsGroup[] => {
  const groups: SettingsGroup[] = []

  for (const row of rows) {
    const last = groups.at(-1)
    if (last !== undefined && last.label === row.definition.group) {
      groups[groups.length - 1] = { label: last.label, rows: [...last.rows, row] }
      continue
    }
    groups.push({ label: row.definition.group, rows: [row] })
  }

  return groups
}

const resolvedOf = (args: {
  definitions: readonly SettingDefinition[]
  resolution: SettingsResolution
}): readonly ResolvedSetting[] => {
  const rows: ResolvedSetting[] = []
  for (const definition of args.definitions) {
    const held = args.resolution.settings.get(definition.id)
    if (held !== undefined) rows.push(held)
  }
  return rows
}

export function settingsModel(args: {
  definitions: readonly SettingDefinition[]
  resolution: SettingsResolution
  pages?: readonly SettingPage[]
}): SettingsModel {
  const pages: SettingsPageModel[] = []

  for (const page of args.pages ?? SETTING_PAGES) {
    const rows = resolvedOf({
      definitions: definitionsOfPage({ definitions: args.definitions, page: page.id }),
      resolution: args.resolution,
    })
    if (rows.length === 0) continue

    pages.push({ page, groups: groupsOf(rows), rows })
  }

  return { pages }
}

export const openSettings = (): SettingsState => ({ pageIndex: 0, rowIndex: 0 })

export function currentPage(args: {
  state: SettingsState
  model: SettingsModel
}): SettingsPageModel | undefined {
  return args.model.pages[args.state.pageIndex]
}

export function currentRow(args: {
  state: SettingsState
  model: SettingsModel
}): ResolvedSetting | undefined {
  return currentPage(args)?.rows[args.state.rowIndex]
}

export function movePage(args: {
  state: SettingsState
  model: SettingsModel
  delta: number
}): SettingsState {
  const pageIndex = wrapped({
    index: args.state.pageIndex + Math.trunc(args.delta),
    length: args.model.pages.length,
  })

  return { pageIndex, rowIndex: 0 }
}

export function moveRow(args: {
  state: SettingsState
  model: SettingsModel
  delta: number
}): SettingsState {
  const page = currentPage(args)
  if (page === undefined) return args.state

  return {
    pageIndex: args.state.pageIndex,
    rowIndex: clamped({
      index: args.state.rowIndex + Math.trunc(args.delta),
      length: page.rows.length,
    }),
  }
}
