'use client';
import type { JobRef } from '@/lib/api/job-api';
import { useRepoFile } from '@/lib/api/job-queries';
import { useRef, useMemo, useEffect } from 'react';
import { langFromPath } from '../../tool-calls/highlight';
import { CodeListing } from '../../tool-calls/ui';
import { ImageViewer } from '../chrome/image-viewer';
import { MAX_HIGHLIGHTED_FILE_LINES, Placeholder } from './step-view';

export function RepoFileBody({
    jobRef, path, lines,
}: {
    jobRef: JobRef;
    path: string;
    lines: string | null;
}) {
    const { data, isLoading, error } = useRepoFile(jobRef, path);
    const containerRef = useRef<HTMLDivElement>(null);

    // Parse "18" / "18-24" → the active line-number set + the first line to scroll to.
    const { activeNos, firstLine } = useMemo(() => {
        const empty = {
            activeNos: undefined as Set<number> | undefined,
            firstLine: null as number | null,
        };
        if (!lines) return empty;
        const m = /^(\d+)(?:-(\d+))?$/.exec(lines);
        if (!m) return empty;
        const start = Number(m[1]);
        if (!Number.isSafeInteger(start) || start < 1) return empty;
        const rawEnd = m[2] ? Number(m[2]) : start;
        const endCandidate = Number.isSafeInteger(rawEnd) && rawEnd >= start ? rawEnd : start;
        const end = Math.min(endCandidate, start + MAX_HIGHLIGHTED_FILE_LINES - 1);
        const set = new Set<number>();
        for (let n = start; n <= end; n++) set.add(n);
        return { activeNos: set, firstLine: start };
    }, [lines]);

    useEffect(() => {
        if (!data || firstLine == null) return;
        const el = containerRef.current?.querySelector(`[data-line="${firstLine}"]`);
        el?.scrollIntoView({ block: 'center' });
    }, [data, firstLine]);

    if (isLoading)
        return (
            <div className="px-8 py-7">
                <p className="font-mono text-[11.5px] text-faint">Loading…</p>
            </div>
        );
    if (error)
        return (
            <div className="px-8 py-7">
                <Placeholder
                    title="Couldn’t load file"
                    body={error instanceof Error ? error.message : 'Unknown error reading this file.'} />
            </div>
        );
    if (!data) return null;
    if (data.mime.startsWith('image/')) {
        const src = data.encoding === 'base64'
            ? `data:${data.mime};base64,${data.content}`
            : `data:${data.mime};utf8,${encodeURIComponent(data.content)}`;
        return (
            <div className="h-full overflow-y-auto px-8 py-7">
                <ImageViewer src={src} alt={data.name} />
            </div>
        );
    }
    const lang = langFromPath(path);
    const rows = data.content
        .replace(/\n$/, '')
        .split('\n')
        .map((code, i) => ({ no: i + 1, code }));
    return (
        <div ref={containerRef} className="h-full overflow-hidden">
            <CodeListing rows={rows} lang={lang} activeNos={activeNos} maxHeight="100%" whole flush />
        </div>
    );
}
