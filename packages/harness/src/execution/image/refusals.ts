export enum EConfigRefusal {
  NotJson = 'not-json',
  BadShape = 'bad-shape',
  Unreadable = 'unreadable',
  MountRelative = 'mount-relative',
  MountDotDot = 'mount-dot-dot',
  MountOverLong = 'mount-over-long',
  MountReserved = 'mount-reserved',
}

export type ConfigRefusal = {
  refusal: EConfigRefusal
  file: string
  detail: string
}
