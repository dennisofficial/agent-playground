'use client';

import { useEffect, useRef, useState } from 'react';

// Mermaid touches the DOM, so it's imported lazily inside the effect (never during SSR) and
// initialized once per page load.
let initialized = false;
let seq = 0;

/**
 * Renders a single Mermaid diagram client-side. A malformed diagram (LLM-authored plans WILL produce
 * some) degrades to its source text in an amber box rather than blanking the page.
 */
export function Mermaid({ chart }: { chart: string }) {
  const [svg, setSvg] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);
  const idRef = useRef(`mmd-${seq++}`);

  useEffect(() => {
    let cancelled = false;
    setSvg(null);
    setFailed(false);
    void (async () => {
      try {
        const mermaid = (await import('mermaid')).default;
        if (!initialized) {
          mermaid.initialize({
            startOnLoad: false,
            securityLevel: 'strict',
            theme: 'neutral',
            flowchart: { htmlLabels: false },
          });
          initialized = true;
        }
        const { svg: rendered } = await mermaid.render(idRef.current, chart);
        if (!cancelled) setSvg(rendered);
      } catch {
        if (!cancelled) setFailed(true);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [chart]);

  if (failed) {
    return (
      <pre className="my-4 overflow-x-auto rounded-md border border-amber-300 bg-amber-50 p-3 text-xs text-amber-900 dark:border-amber-700 dark:bg-amber-950 dark:text-amber-200">
        <code>{chart}</code>
      </pre>
    );
  }
  if (svg === null) {
    return (
      <div className="my-4 rounded-md border border-zinc-200 p-4 text-xs text-zinc-400 dark:border-zinc-800 dark:text-zinc-500">
        Rendering diagram…
      </div>
    );
  }
  return (
    <div
      className="my-4 flex justify-center overflow-x-auto rounded-md border border-zinc-200 bg-white p-4 dark:border-zinc-800 dark:bg-zinc-950 [&_svg]:max-w-full"
      // Mermaid output is sanitized (securityLevel: 'strict').
      dangerouslySetInnerHTML={{ __html: svg }}
    />
  );
}
