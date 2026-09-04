export enum EMountMode {
  ReadOnly = 'ro',
  ReadWrite = 'rw',
}

export type Mount = {
  path: string
  mode: EMountMode
}

export const mountBind = (mount: Mount): string =>
  `${mount.path}:${mount.path}${mount.mode === EMountMode.ReadOnly ? ':ro' : ''}`
