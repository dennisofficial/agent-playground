import { EContextSlot, mentionedFilePaths, type EventDraft } from '@dltech/atlas-core'
import { EFileLoad, type FileBrowser } from '@dltech/atlas-harness'

export type MentionedFile = { path: string; content: string }

export type FileLoader = (path: string) => Promise<MentionedFile | null>

const TRUNCATION_NOTICE = (path: string): string =>
  `\n\n[${path} was too large to attach whole; the rest was left out. Read it with the read tool if you need more.]`

export function workspaceFileLoader(browser: FileBrowser): FileLoader {
  return async (path: string): Promise<MentionedFile | null> => {
    const loaded = await browser.load(path)

    if (loaded.type === EFileLoad.Refused) return null
    if (loaded.type === EFileLoad.Listing) {
      return { path, content: `${path} is a directory holding:\n\n${loaded.content}` }
    }

    return {
      path,
      content: loaded.truncated ? `${loaded.content}${TRUNCATION_NOTICE(path)}` : loaded.content,
    }
  }
}

export async function mentionedFileDrafts(args: {
  text: string
  load: FileLoader
}): Promise<readonly EventDraft[]> {
  const paths = mentionedFilePaths(args.text)
  if (paths.length === 0) return []

  const loaded = await Promise.all(paths.map((path) => args.load(path)))

  return loaded.flatMap((file): EventDraft[] =>
    file === null
      ? []
      : [
          {
            type: 'context-loaded',
            slot: EContextSlot.File,
            key: file.path,
            content: file.content,
          },
        ],
  )
}
