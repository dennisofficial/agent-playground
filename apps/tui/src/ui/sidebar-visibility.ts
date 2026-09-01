import { MIN_TRANSCRIPT_WIDTH, SIDEBAR_GUTTER } from './theme'

export enum ESidebarLayout {
  Wide = 'wide',
  Narrow = 'narrow',
}

export function sidebarFoldsAt(args: { foldBelow: number; sidebarWidth: number }): number {
  return Math.max(args.foldBelow, args.sidebarWidth + SIDEBAR_GUTTER + MIN_TRANSCRIPT_WIDTH)
}

export function sidebarLayout(args: {
  width: number
  foldBelow: number
  sidebarWidth: number
}): ESidebarLayout {
  return args.width > sidebarFoldsAt(args) ? ESidebarLayout.Wide : ESidebarLayout.Narrow
}

export function sidebarShown(args: { layout: ESidebarLayout; peeking: boolean }): boolean {
  return args.layout === ESidebarLayout.Wide || args.peeking
}

export function peekInForce(args: { layout: ESidebarLayout; peeking: boolean }): boolean {
  return args.layout === ESidebarLayout.Narrow && args.peeking
}

export function floatingSidebarWidth(args: { width: number; sidebarWidth: number }): number {
  return Math.min(args.sidebarWidth, args.width)
}

type Beside = { width: number; sidebarWidth: number; docked: boolean }

export function contentWidthOf(args: Beside): number {
  return args.docked ? Math.max(1, args.width - args.sidebarWidth) : args.width
}

export function chromeWidthOf(args: Beside): number {
  return args.docked ? Math.max(1, args.width - args.sidebarWidth - SIDEBAR_GUTTER) : args.width
}
