import { useCallback, useMemo, useRef, useState } from 'react'

import type { ClipboardImageReader } from '../clipboard-image'
import { attachImage, noDraftImages, type DraftImage } from '../draft-images'

export type DraftImages = {
  images: readonly DraftImage[]
  handleAttach: () => Promise<DraftImage | null>
  restore: (images: readonly DraftImage[]) => void
  clear: () => void
}

/**
 * The held pictures are mirrored in a ref because the caller needs the one it just attached — to
 * write its tag into the buffer — in the same tick, and the state it was numbered against has not
 * re-rendered yet.
 */
export function useDraftImages(args: {
  read: ClipboardImageReader
  directory: string
}): DraftImages {
  const [images, setImages] = useState<readonly DraftImage[]>(noDraftImages)
  const held = useRef<readonly DraftImage[]>(noDraftImages)
  const { read, directory } = args

  const commit = useCallback((next: readonly DraftImage[]) => {
    held.current = next
    setImages(next)
  }, [])

  const handleAttach = useCallback(async (): Promise<DraftImage | null> => {
    const image = await read({ directory })
    if (image === null) return null

    const next = attachImage({ images: held.current, image })
    commit(next)

    return next[next.length - 1] ?? null
  }, [commit, directory, read])

  const restore = useCallback((next: readonly DraftImage[]) => commit(next), [commit])

  const clear = useCallback(() => commit(noDraftImages), [commit])

  return useMemo(
    () => ({ images, handleAttach, restore, clear }),
    [clear, handleAttach, images, restore],
  )
}
