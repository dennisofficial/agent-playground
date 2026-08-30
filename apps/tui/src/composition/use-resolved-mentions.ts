import { useEffect, useMemo, useState } from 'react'

import { mentionedFilePaths, resolvedFileMentions, type FileMention } from '@dltech/atlas-core'
import type { FileBrowser } from '@dltech/atlas-harness'

/**
 * A mention is painted only once the filesystem has confirmed it, so what is lit in the composer
 * is what will be attached. The browser answers each path once, so typing costs one question per
 * spelling rather than one per keystroke.
 */
export function useResolvedMentions(args: {
  text: string
  files?: FileBrowser | undefined
}): readonly FileMention[] {
  const [known, setKnown] = useState<ReadonlySet<string>>(() => new Set<string>())
  const { files, text } = args

  useEffect(() => {
    if (files === undefined) return

    const paths = mentionedFilePaths(text).filter((path) => !known.has(path))
    if (paths.length === 0) return

    let live = true

    void Promise.all(
      paths.map(async (path) => ({ path, found: await files.exists(path) })),
    ).then((answers) => {
      if (!live) return

      const found = answers.filter((answer) => answer.found).map((answer) => answer.path)
      if (found.length === 0) return

      setKnown((current) => {
        const missing = found.filter((path) => !current.has(path))
        return missing.length === 0 ? current : new Set([...current, ...missing])
      })
    })

    return () => {
      live = false
    }
  }, [files, known, text])

  return useMemo(() => resolvedFileMentions({ text, known }), [known, text])
}
