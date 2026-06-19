'use client';

import type { SectionView } from '@workspace/shared';
import { Mermaid } from './mermaid';
import { statusHexFill } from './status';

/**
 * Section dependency graph, built deterministically from the pipeline's sections. `depends_on` holds
 * the section ordinals a section waits on; an EMPTY `depends_on` means "strictly ordinal-sequential"
 * (per the entity contract), so we draw an edge from the previous section. Nodes are tinted by status.
 * Reuses the same <Mermaid> renderer as the LLM-authored diagrams.
 */
export function DependencyGraph({ sections }: { sections: SectionView[] }) {
  if (sections.length < 2) return null;
  return <Mermaid chart={buildGraph(sections)} />;
}

function buildGraph(sections: SectionView[]): string {
  const ordinals = new Set(sections.map((s) => s.ordinal));
  const lines: string[] = ['graph TD'];

  for (const s of sections) {
    lines.push(`  n${s.ordinal}["${escapeLabel(s.name)}"]`);
  }

  sections.forEach((s, i) => {
    const explicit = s.dependsOn.filter((d) => ordinals.has(d));
    if (explicit.length > 0) {
      for (const dep of explicit) lines.push(`  n${dep} --> n${s.ordinal}`);
    } else if (i > 0) {
      // empty depends_on → implicit sequential order
      lines.push(`  n${sections[i - 1].ordinal} --> n${s.ordinal}`);
    }
  });

  for (const s of sections) {
    lines.push(
      `  style n${s.ordinal} fill:${statusHexFill(s.status)},stroke:#a1a1aa,color:#18181b`,
    );
  }

  return lines.join('\n');
}

/** Mermaid node labels can't contain unescaped quotes or brackets. */
function escapeLabel(name: string): string {
  return name.replace(/["[\]{}]/g, '').trim() || 'section';
}
