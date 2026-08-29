import { SIDEBAR_MIN_TERMINAL_WIDTH } from './theme'

export enum ESidebarLayout {
  Wide = 'wide',
  Narrow = 'narrow',
}

export type SidebarChoice = { layout: ESidebarLayout; shown: boolean }

export function sidebarLayout(width: number): ESidebarLayout {
  return width > SIDEBAR_MIN_TERMINAL_WIDTH ? ESidebarLayout.Wide : ESidebarLayout.Narrow
}

export function sidebarChoiceInForce(args: {
  layout: ESidebarLayout
  choice: SidebarChoice | null
}): SidebarChoice | null {
  return args.choice?.layout === args.layout ? args.choice : null
}

export function sidebarShown(args: {
  layout: ESidebarLayout
  choice: SidebarChoice | null
}): boolean {
  return sidebarChoiceInForce(args)?.shown ?? args.layout === ESidebarLayout.Wide
}

export function flipSidebar(args: {
  layout: ESidebarLayout
  choice: SidebarChoice | null
}): SidebarChoice {
  return { layout: args.layout, shown: !sidebarShown(args) }
}
