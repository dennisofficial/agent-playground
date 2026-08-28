export enum ECommandKind {
  Local = 'local',
  Skill = 'skill',
}

export enum ECommandGroup {
  Context = 'Context',
  Session = 'Session',
  Workspace = 'Workspace',
}

export type CommandSpec = {
  name: string
  kind: ECommandKind
  summary: string
  group: ECommandGroup
  argumentHint?: string | undefined
}

export const qualifiedName = (spec: CommandSpec): string => `${spec.kind}:${spec.name}`
