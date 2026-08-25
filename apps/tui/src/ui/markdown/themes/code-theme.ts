import type { StyleDefinitionInput } from '@opentui/core'

export enum EDiffLineKind {
  context = 'context',
  added = 'added',
  removed = 'removed',
  gap = 'gap',
}

export type CodeRole =
  | 'plain'
  | 'keyword'
  | 'string'
  | 'escape'
  | 'comment'
  | 'function'
  | 'type'
  | 'constant'
  | 'key'
  | 'property'
  | 'variable'
  | 'module'
  | 'attribute'
  | 'tag'
  | 'operator'
  | 'punctuation'
  | 'heading'
  | 'bold'
  | 'italic'
  | 'quote'
  | 'listMarker'
  | 'link'
  | 'rawInline'
  | 'strikethrough'

export type DiffPalette = {
  readonly added: StyleDefinitionInput
  readonly removed: StyleDefinitionInput
  readonly hunk: StyleDefinitionInput
  readonly meta: StyleDefinitionInput
  readonly context: StyleDefinitionInput
}

export type DiffRowStyle = {
  readonly gutter: StyleDefinitionInput
  readonly content: StyleDefinitionInput
}

export type DiffRowPalette = Readonly<Record<EDiffLineKind, DiffRowStyle>>

export type CodeTheme = {
  readonly label: string
  readonly roles: Readonly<Record<CodeRole, StyleDefinitionInput>>
  readonly overrides?: Readonly<Record<string, Partial<Record<CodeRole, StyleDefinitionInput>>>>
  readonly diff: DiffPalette
  readonly diffRows: DiffRowPalette
}

export function rolesFor(args: {
  theme: CodeTheme
  filetype?: string
}): Record<CodeRole, StyleDefinitionInput> {
  const override = args.filetype ? args.theme.overrides?.[args.filetype] : undefined
  return override ? { ...args.theme.roles, ...override } : { ...args.theme.roles }
}

export function codeScopes(args: {
  theme: CodeTheme
  filetype?: string
}): Record<string, StyleDefinitionInput> {
  const roles = rolesFor(args)
  return {
    keyword: roles.keyword,
    conditional: roles.keyword,
    storageclass: roles.keyword,
    'type.qualifier': roles.keyword,
    comment: roles.comment,
    string: roles.string,
    'string.special.key': roles.key,
    'string.escape': roles.escape,
    escape: roles.escape,
    function: roles.function,
    type: roles.type,
    constructor: roles.type,
    constant: roles.constant,
    number: roles.constant,
    float: roles.constant,
    boolean: roles.constant,
    character: roles.escape,
    property: roles.property,
    'variable.member': roles.property,
    field: roles.property,
    variable: roles.variable,
    parameter: roles.variable,
    module: roles.module,
    attribute: roles.attribute,
    label: roles.attribute,
    tag: roles.tag,
    operator: roles.operator,
    punctuation: roles.punctuation,

    'markup.heading': roles.heading,
    'markup.heading.1': roles.heading,
    'markup.heading.2': roles.heading,
    'markup.heading.3': roles.heading,
    'markup.heading.4': roles.heading,
    'markup.heading.5': roles.heading,
    'markup.heading.6': roles.heading,
    'markup.strong': roles.bold,
    'markup.bold': roles.bold,
    'markup.italic': roles.italic,
    'markup.strikethrough': roles.strikethrough,
    'markup.quote': roles.quote,
    'markup.list': roles.listMarker,
    'markup.list.checked': roles.listMarker,
    'markup.list.unchecked': roles.listMarker,
    'markup.link': roles.link,
    'markup.link.url': roles.link,
    'markup.link.label': roles.link,
    'markup.link.bracket.close': roles.link,
    'markup.raw': roles.rawInline,
    'markup.raw.block': roles.rawInline,
  }
}
