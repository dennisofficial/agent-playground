import {
  EContextSlot,
  EInstructionOrigin,
  instructionCandidates,
  type EInstructionFamily,
  type FileSystemPort,
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

export async function readInstructionFiles(
  request: InstructionRequest,
): Promise<readonly LoadedInstruction[]> {
  const candidates = instructionCandidates({
    root: request.root,
    cwd: request.cwd,
    userDirectories: request.userDirectories,
    family: request.family,
    includeUser: request.includeUser,
    includeProject: request.includeProject,
  })

  const budget = request.characterBudget ?? DEFAULT_INSTRUCTION_CHARACTER_BUDGET
  const loaded: LoadedInstruction[] = []
  let spent = 0

  for (const candidate of candidates) {
    const content = await readInstructionFile({ path: candidate.path, files: request.files })
    if (content === undefined) continue
    if (spent + content.length > budget) continue

    spent += content.length
    loaded.push({ path: candidate.path, slot: slotOf(candidate.origin), content })
  }

  return loaded
}
