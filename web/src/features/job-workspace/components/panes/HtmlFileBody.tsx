'use client';
import { type JobRef, contextRawUrl } from '@/lib/api/job-api';
import type { ContextFileContent } from '@/lib/api/types';

export function HtmlFileBody({ file, jobRef }: { file: ContextFileContent; jobRef: JobRef; }) {
    return (
        <iframe
            src={contextRawUrl(jobRef, file.path)}
            title={file.name}
            sandbox="allow-scripts"
            className="h-full w-full flex-1 border-0 bg-surface" />
    );
}
