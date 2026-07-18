'use client';

import { Maximize2, Minimize2, RotateCcw, X, ZoomIn, ZoomOut } from 'lucide-react';
import { useCallback, useEffect, useState, type ReactNode } from 'react';
import { TransformComponent, TransformWrapper, useControls } from 'react-zoom-pan-pinch';

const MIN_SCALE = 0.5;
const MAX_SCALE = 8;

/**
 * A polished, in-pane photo viewer for the detail pane's image files. Wheel / pinch to zoom, drag to
 * pan, double-click to toggle zoom, and a toolbar for +/−/reset plus a fullscreen overlay (Esc to exit).
 * Replaces the plain letterboxed `<img>` so large screenshots can actually be inspected.
 */
export function ImageViewer({ src, alt }: { src: string; alt: string }) {
  const [fullscreen, setFullscreen] = useState(false);
  const toggleFullscreen = useCallback(() => setFullscreen((v) => !v), []);

  useEffect(() => {
    if (!fullscreen) return;
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') setFullscreen(false);
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [fullscreen]);

  if (fullscreen) {
    return (
      <div className="fixed inset-0 z-[90] bg-black/90">
        <button
          type="button"
          onClick={toggleFullscreen}
          aria-label="Exit fullscreen"
          className="absolute right-4 top-4 z-20 rounded-md p-1.5 text-white/70 transition hover:bg-white/10 hover:text-white"
        >
          <X size={18} />
        </button>
        <div className="h-full w-full p-6">
          <Viewer src={src} alt={alt} fullscreen onToggleFullscreen={toggleFullscreen} />
        </div>
      </div>
    );
  }

  return (
    <div className="relative h-full w-full flex-1 overflow-hidden bg-surface-2">
      <Viewer src={src} alt={alt} fullscreen={false} onToggleFullscreen={toggleFullscreen} />
    </div>
  );
}

function Viewer({
  src,
  alt,
  fullscreen,
  onToggleFullscreen,
}: {
  src: string;
  alt: string;
  fullscreen: boolean;
  onToggleFullscreen: () => void;
}) {
  return (
    <TransformWrapper
      minScale={MIN_SCALE}
      maxScale={MAX_SCALE}
      centerOnInit
      wheel={{ step: 0.015 }}
      doubleClick={{ mode: 'toggle', step: 1.2 }}
    >
      <Toolbar fullscreen={fullscreen} onToggleFullscreen={onToggleFullscreen} />
      <TransformComponent
        wrapperClass="!h-full !w-full cursor-grab active:cursor-grabbing"
        contentClass="!h-full !w-full flex items-center justify-center"
      >
        {/* eslint-disable-next-line @next/next/no-img-element -- a data: URL, not a remote asset for next/image */}
        <img
          src={src}
          alt={alt}
          draggable={false}
          className="max-h-full max-w-full select-none object-contain"
        />
      </TransformComponent>
    </TransformWrapper>
  );
}

function Toolbar({
  fullscreen,
  onToggleFullscreen,
}: {
  fullscreen: boolean;
  onToggleFullscreen: () => void;
}) {
  const { zoomIn, zoomOut, resetTransform } = useControls();
  return (
    <div className="absolute right-2 top-2 z-10 flex items-center gap-0.5 rounded-md border border-border bg-panel/90 p-0.5 shadow-sm backdrop-blur">
      <ToolbarButton title="Zoom in" onClick={() => zoomIn()}>
        <ZoomIn size={15} />
      </ToolbarButton>
      <ToolbarButton title="Zoom out" onClick={() => zoomOut()}>
        <ZoomOut size={15} />
      </ToolbarButton>
      <ToolbarButton title="Reset" onClick={() => resetTransform()}>
        <RotateCcw size={15} />
      </ToolbarButton>
      <ToolbarButton
        title={fullscreen ? 'Exit fullscreen' : 'Fullscreen'}
        onClick={onToggleFullscreen}
      >
        {fullscreen ? <Minimize2 size={15} /> : <Maximize2 size={15} />}
      </ToolbarButton>
    </div>
  );
}

function ToolbarButton({
  title,
  onClick,
  children,
}: {
  title: string;
  onClick: () => void;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      title={title}
      onClick={onClick}
      className="flex h-[29px] w-[29px] items-center justify-center rounded-sm text-dim transition hover:bg-surface-2 hover:text-text"
    >
      {children}
    </button>
  );
}
