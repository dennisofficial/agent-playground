import {
  EContextSlot,
  EInstructionOrigin,
  instructionCandidates,
  nestedInstructionCandidates,
  type EInstructionFamily,
  type FileSystemPort,
  type InstructionCandidate,
} from '@dltech/atlas-core'

import { LocalFileSystemPort } from '../execution/local-filesystem'

export type LoadedInstruction = {
  path: string
  slot: EContextSlot
  content: string
}

export type InstructionRequest = {
  root: string
  cwd: string
  userDirectories: readonly string[]
  family: EInstructionFamily
  includeUser: boolean
  includeProject: boolean
  characterBudget?: number
  files?: FileSystemPort | undefined
}

export const DEFAULT_INSTRUCTION_CHARACTER_BUDGET = 40_000

const slotOf = (origin: EInstructionOrigin): EContextSlot =>
  origin === EInstructionOrigin.UserGlobal
    ? EContextSlot.UserInstructions
    : EContextSlot.ProjectInstructions

export async function readInstructionFile(args: {
  path: string
  files?: FileSystemPort | undefined
}): Promise<string | undefined> {
  const files = args.files ?? new LocalFileSystemPort()
  try {
    const stats = await files.stat({ path: args.path })
    if (!stats.isFile()) return undefined

    const content = await files.readFile({ path: args.path })
    return content.trim() === '' ? undefined : content
  } catch {
    return undefined
  }
}

export type NestedInstructionRequest = {
  root: string
  cwd: string
  touchedDirectory: string
  family: EInstructionFamily
  characterBudget?: number
  files?: FileSystemPort | undefined
}

async function readCandidates(args: {
  candidates: readonly InstructionCandidate[]
  characterBudget?: number | undefined
  files?: FileSystemPort | undefined
  slotOf: (origin: EInstructionOrigin) => EContextSlot
}): Promise<readonly LoadedInstruction[]> {
  const budget = args.characterBudget ?? DEFAULT_INSTRUCTION_CHARACTER_BUDGET
  const loaded: LoadedInstruction[] = []
  let spent = 0

  for (const candidate of args.candidates) {
    const content = await readInstructionFile({ path: candidate.path, files: args.files })
    if (content === undefined) continue
    if (spent + content.length > budget) continue

    spent += content.length
    loaded.push({ path: candidate.path, slot: args.slotOf(candidate.origin), content })
  }

  return loaded
}

export async function readInstructionFiles(
  request: InstructionRequest,
): Promise<readonly LoadedInstruction[]> {
  return readCandidates({
    candidates: instructionCandidates({
      root: request.root,
      cwd: request.cwd,
      userDirectories: request.userDirectories,
      family: request.family,
      includeUser: request.includeUser,
      includeProject: request.includeProject,
    }),
    characterBudget: request.characterBudget,
    files: request.files,
    slotOf,
  })
}

export async function readNestedInstructionFiles(
  request: NestedInstructionRequest,
): Promise<readonly LoadedInstruction[]> {
  return readCandidates({
    candidates: nestedInstructionCandidates({
      root: request.root,
      cwd: request.cwd,
      touchedDirectory: request.touchedDirectory,
      family: request.family,
    }),
    characterBudget: request.characterBudget,
    files: request.files,
    slotOf: () => EContextSlot.NestedInstructions,
  })
}
