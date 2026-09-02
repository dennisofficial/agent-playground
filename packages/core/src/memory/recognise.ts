import { ATLAS_DIRECTORY_NAME } from '../workspace/atlas-home'
import { MEMORY_DIRECTORY_NAME, MEMORY_INDEX_NAME, MEMORY_PROJECTS_DIRECTORY_NAME } from './roots'

const SEPARATOR = '/'
const MARKDOWN = '.md'

const HOME_NAME = ATLAS_DIRECTORY_NAME

const segmentsOf = (path: string): readonly string[] =>
  path.split(SEPARATOR).filter((segment) => segment.length > 0)

export function looksLikeMemoryPath(path: string): boolean {
  if (!path.endsWith(MARKDOWN)) return false

  const segments = segmentsOf(path)
  const parent = segments.at(-2)
  if (parent !== MEMORY_DIRECTORY_NAME) return false

  const grandparent = segments.at(-3)
  if (grandparent === undefined) return false
  if (grandparent === HOME_NAME) return true

  return segments.at(-4) === MEMORY_PROJECTS_DIRECTORY_NAME
}

export const isMemoryIndexPath = (path: string): boolean =>
  looksLikeMemoryPath(path) && segmentsOf(path).at(-1) === MEMORY_INDEX_NAME

export function memoryNameOf(path: string): string | undefined {
  if (!looksLikeMemoryPath(path)) return undefined

  const file = segmentsOf(path).at(-1)
  if (file === undefined) return undefined

  return file.slice(0, -MARKDOWN.length)
}

const escaped = (value: string): string => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

/**
 * A memory path as it appears inside a shell command, where there is no argument to inspect — only
 * the line the model wrote. Anchored on the directory that OWNS a memory directory, so a repository
 * with its own `src/memory/` is not mistaken for one.
 */
export const MEMORY_MENTION = new RegExp(
  `(?:${escaped(HOME_NAME)}|${escaped(MEMORY_PROJECTS_DIRECTORY_NAME)}/[^\\s'"/]+)/${escaped(MEMORY_DIRECTORY_NAME)}(?:/|\\b)`,
)

export const mentionsMemoryPath = (text: string): boolean => MEMORY_MENTION.test(text)
