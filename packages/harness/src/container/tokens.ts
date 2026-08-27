import type { LanguageModelV4 } from '@ai-sdk/provider'

import type { PrismaClient } from '../../prisma/generated/client'
import type { KeychainReader } from '../credentials/keychain-reader'
import type { HookRegistry } from '../hooks/registry'
import type { Dispatch } from '../tools/dispatch'
import type { InjectionToken } from './injection'

export const PrismaClientToken: InjectionToken<PrismaClient> = Symbol('atlas.PrismaClient')

export const WorkspaceRoot: InjectionToken<string> = Symbol('atlas.WorkspaceRoot')

export const KeychainReaderToken: InjectionToken<KeychainReader> = Symbol('atlas.KeychainReader')

export const LanguageModelToken: InjectionToken<LanguageModelV4> = Symbol('atlas.LanguageModel')

export const HookRegistryToken: InjectionToken<HookRegistry> = Symbol('atlas.HookRegistry')

export const DispatchToken: InjectionToken<Dispatch> = Symbol('atlas.Dispatch')
