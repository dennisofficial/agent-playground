// tsyringe throws from its own module body when `Reflect.getMetadata` is absent, so the polyfill
// import must stay above it. Every decorated class in this package reaches tsyringe through here
// rather than importing it directly, which is what keeps that ordering true.
import 'reflect-metadata'

import { container, type DependencyContainer, type InjectionToken } from 'tsyringe'

export { inject, injectable } from 'tsyringe'
export type { DependencyContainer, InjectionToken } from 'tsyringe'

export type PortConstructor<T> = abstract new (...args: never[]) => T

// tsyringe 4.10 defines `InjectionToken<T>` over `{ new (...args: any[]): T }`, which an abstract
// constructor is not assignable to, so a port cannot be handed to `register`/`resolve`/`inject`
// unaided. https://github.com/microsoft/tsyringe/blob/master/src/providers/injection-token.ts
export const portToken = <T>(port: PortConstructor<T>): InjectionToken<T> => port as InjectionToken<T>

export const createIsolatedContainer = (): DependencyContainer => container.createChildContainer()
