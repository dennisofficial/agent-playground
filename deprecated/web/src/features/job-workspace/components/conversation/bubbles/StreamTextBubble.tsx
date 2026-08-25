'use client';
import { contextConvoNodeForHref } from '@/features/job-workspace/lib/node-registry';
import { usePathname } from 'next/navigation';
import { useMemo } from 'react';
import { Markdown } from '../markdown';

export function StreamTextBubble({
  text,
  streaming = false,
  onSelectNode,
}: {
  text: string;
  streaming?: boolean;
  onSelectNode?: (node: string) => void;
}) {
  const pathname = usePathname();
  const resolveRelativeLink = useMemo(() => {
    if (!onSelectNode) return undefined;
    return (href: string) => {
      const node = contextConvoNodeForHref(href);
      if (!node) return null;
      return {
        url: `${pathname}?node=${encodeURIComponent(node)}`,
        onSelect: () => onSelectNode(node),
      };
    };
  }, [onSelectNode, pathname]);

  return (
    <div className="anim-fadeUp">
      <Markdown
        className={streaming ? 'md-caret' : undefined}
        resolveRelativeLink={resolveRelativeLink}
      >
        {text}
      </Markdown>
    </div>
  );
}
