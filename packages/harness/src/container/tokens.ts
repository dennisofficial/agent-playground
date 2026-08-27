import type { PrismaClient } from '../../prisma/generated/client'
import type { KeychainReader } from '../credentials/keychain-reader'
import type { InjectionToken } from './injection'

export const PrismaClientToken: InjectionToken<PrismaClient> = Symbol('atlas.PrismaClient')

export const WorkspaceRoot: InjectionToken<string> = Symbol('atlas.WorkspaceRoot')

export const KeychainReaderToken: InjectionToken<KeychainReader> = Symbol('atlas.KeychainReader')
