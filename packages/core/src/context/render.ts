import { EContextSlot } from './slot'

const OPEN = '<system-reminder>'
const CLOSE = '</system-reminder>'

const LOCAL_SUFFIX = '.local.md'

export const wrapInSystemReminder = (text: string): string => `${OPEN}\n${text}\n${CLOSE}`

const isLocalFile = (key: string): boolean => key.endsWith(LOCAL_SUFFIX)

function provenanceOf({ slot, key }: { slot: string; key: string }): string | undefined {
  if (slot === EContextSlot.UserInstructions) {
    return `Contents of ${key} (the user's private global instructions for all projects):`
  }

  if (slot === EContextSlot.ProjectInstructions) {
    return isLocalFile(key)
      ? `Contents of ${key} (the user's private project instructions, not checked in):`
      : `Contents of ${key} (project instructions, checked into the codebase):`
  }

  if (slot === EContextSlot.NestedInstructions) {
    return `Contents of ${key} (instructions for the directory it sits in, loaded because a tool touched a file beneath it):`
  }

  if (slot === EContextSlot.Skill) {
    return `The ${key} skill, loaded because it was invoked:`
  }

  if (slot === EContextSlot.File) {
    return `Contents of ${key}, loaded because the developer mentioned it:`
  }

  return undefined
}

export function contextBlock({
  slot,
  key,
  content,
}: {
  slot: string
  key: string
  content: string
}): string {
  const provenance = provenanceOf({ slot, key })

  return wrapInSystemReminder(provenance === undefined ? content : `${provenance}\n\n${content}`)
}
