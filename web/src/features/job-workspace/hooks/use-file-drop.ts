'use client';

import { useCallback, useRef, useState } from 'react';

/**
 * File drag-and-drop intake for a region. Returns `isDragging` (true while a FILE drag hovers the region)
 * plus `dropHandlers` to spread onto the region's root element — dropped files are handed to `onFiles`, the
 * same funnel the paste handler and the ＋ picker use.
 *
 * Two details this handles so the caller doesn't have to:
 *  - It reacts ONLY to file drags (the `Files` type check) — dragging selected text or a DOM node is ignored,
 *    so an accidental text-select drag never flashes the drop overlay.
 *  - dragenter/dragleave fire once per descendant element, so a depth counter tracks the TRUE enter/leave of
 *    the region (naively toggling on every dragleave would flicker as the cursor crosses child boundaries).
 *
 * `dragover` MUST call `preventDefault()` or the browser refuses the drop; `drop` calls it too so the browser
 * doesn't navigate away to render the dropped file. When `enabled` is false the handlers are inert no-ops.
 */
export function useFileDrop(onFiles: (files: File[]) => void, enabled = true) {
  const [isDragging, setIsDragging] = useState(false);
  const depth = useRef(0);

  const hasFiles = (e: React.DragEvent) => Array.from(e.dataTransfer.types).includes('Files');

  const onDragEnter = useCallback(
    (e: React.DragEvent) => {
      if (!enabled || !hasFiles(e)) return;
      e.preventDefault();
      depth.current += 1;
      setIsDragging(true);
    },
    [enabled],
  );

  const onDragOver = useCallback(
    (e: React.DragEvent) => {
      if (!enabled || !hasFiles(e)) return;
      e.preventDefault(); // required — without this the drop is rejected
      e.dataTransfer.dropEffect = 'copy';
    },
    [enabled],
  );

  const onDragLeave = useCallback(
    (e: React.DragEvent) => {
      if (!enabled || !hasFiles(e)) return;
      depth.current -= 1;
      if (depth.current <= 0) {
        depth.current = 0;
        setIsDragging(false);
      }
    },
    [enabled],
  );

  const onDrop = useCallback(
    (e: React.DragEvent) => {
      if (!enabled || !hasFiles(e)) return;
      e.preventDefault();
      depth.current = 0;
      setIsDragging(false);
      const files = Array.from(e.dataTransfer.files);
      if (files.length > 0) onFiles(files);
    },
    [enabled, onFiles],
  );

  return {
    isDragging: enabled && isDragging,
    dropHandlers: { onDragEnter, onDragOver, onDragLeave, onDrop },
  };
}
