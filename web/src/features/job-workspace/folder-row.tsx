import { ChevronRight, Folder } from 'lucide-react';

/** One folder header row inside a SPECS/GENERATED/ARTIFACTS tree — click toggles its subtree. */
export function FolderRow({
  name,
  indent,
  open,
  onClick,
}: {
  name: string;
  indent: number;
  open: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      style={{ paddingLeft: 8 + indent * 14 }}
      className="flex w-full items-center gap-1.5 rounded-sm px-2 py-1 text-left hover:bg-surface-2"
    >
      <Folder size={12} className="shrink-0 text-faint" />
      <span className="flex-1 truncate font-mono text-[10.5px] text-text">{name}</span>
      <ChevronRight
        size={11}
        className={`shrink-0 text-faint transition-transform ${open ? 'rotate-90' : ''}`}
      />
    </button>
  );
}
