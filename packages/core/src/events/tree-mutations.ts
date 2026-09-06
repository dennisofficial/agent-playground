import type { Event } from './envelope'
import { eventsOfType } from './projections'
import { EToolEffect } from '../tools/tool'

export function treeMutationsOf(args: {
  events: readonly Event[]
  effects: (name: string) => EToolEffect | undefined
}): number {
  return eventsOfType({ events: args.events, type: 'tool-result' }).filter(
    (settled) => args.effects(settled.name) !== EToolEffect.Read,
  ).length
}
