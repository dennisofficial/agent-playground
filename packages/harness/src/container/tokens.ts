import type { LanguageModelV4 } from '@ai-sdk/provider'

import type { ClassifierPolicy, SettingsStorePort } from '@dltech/atlas-core'

import type { PrismaClient } from '../../prisma/generated/client'
import type { ClaudeCodeSource } from '../credentials/claude-code-source'
import type { KeychainReader } from '../credentials/keychain-reader'
import type { HookChain } from '../hooks/registry'
import type { InjectionToken } from './injection'

export const PrismaClientToken: InjectionToken<PrismaClient> = Symbol('atlas.PrismaClient')

export const WorkspaceRoot: InjectionToken<string> = Symbol('atlas.WorkspaceRoot')

export const KeychainReaderToken: InjectionToken<KeychainReader> = Symbol('atlas.KeychainReader')

export const ClaudeCodeSourceToken: InjectionToken<ClaudeCodeSource> =
  Symbol('atlas.ClaudeCodeSource')

export const LanguageModelToken: InjectionToken<LanguageModelV4> = Symbol('atlas.LanguageModel')

export const HookChainToken: InjectionToken<HookChain> = Symbol('atlas.HookChain')

export const UserSettingsStoreToken: InjectionToken<SettingsStorePort> = Symbol(
  'atlas.UserSettingsStore',
)

export const ProjectSettingsStoreToken: InjectionToken<SettingsStorePort> = Symbol(
  'atlas.ProjectSettingsStore',
)

export const WorktreeDirectoryToken: InjectionToken<() => string> = Symbol(
  'atlas.WorktreeDirectory',
)

export const ClassifierPolicyToken: InjectionToken<() => ClassifierPolicy> = Symbol(
  'atlas.ClassifierPolicy',
)
