'use client';

import type { FactView } from '@/lib/admin-api';
import { TIER_BADGE_CLASS, TIER_LABEL, relativeTime } from './tiers';

export function FactRow({ fact }: { fact: FactView }) {
  const forgotten = fact.deletedAt !== null;

  return (
    <div
      className={`rounded-lg border px-4 py-3 ${
        forgotten
          ? 'border-zinc-200 bg-white opacity-50 dark:border-zinc-800 dark:bg-zinc-950'
          : 'border-zinc-200 bg-white dark:border-zinc-800 dark:bg-zinc-950'
      }`}
    >
      <div className="flex items-start gap-3">
        {/* Fact content */}
        <p
          className={`flex-1 text-sm leading-relaxed ${
            forgotten
              ? 'text-zinc-500 line-through dark:text-zinc-500'
              : 'text-black dark:text-zinc-50'
          }`}
        >
          {fact.content}
        </p>

        {/* Right-side metadata: tier badge + age */}
        <div className="flex shrink-0 flex-col items-end gap-1.5">
          <span
            className={`rounded-full px-2 py-0.5 text-xs font-medium ${TIER_BADGE_CLASS[fact.tier]}`}
          >
            {TIER_LABEL[fact.tier]}
          </span>
          <time
            dateTime={fact.createdAt}
            title={new Date(fact.createdAt).toLocaleString()}
            className="text-xs text-zinc-400 dark:text-zinc-500"
          >
            {relativeTime(fact.createdAt)}
          </time>
        </div>
      </div>

      {/* Conditional sub-labels */}
      {(fact.projectId !== null ||
        fact.humanId !== null ||
        forgotten ||
        fact.confidence < 1.0) && (
        <div className="mt-1.5 flex flex-wrap items-center gap-x-3 gap-y-1">
          {/* Project label (project-tier facts only) */}
          {fact.projectId !== null && (
            <span className="font-mono text-xs text-zinc-500 dark:text-zinc-400">
              {fact.projectId}
            </span>
          )}

          {/* Private label (pair-tier facts only) */}
          {fact.humanId !== null && (
            <span className="text-xs text-zinc-500 dark:text-zinc-400">
              Private · with {fact.humanId}
            </span>
          )}

          {/* Confidence — only shown when < 1.0 */}
          {fact.confidence < 1.0 && (
            <span className="text-xs text-zinc-400 dark:text-zinc-500">
              {Math.round(fact.confidence * 100)}% confidence
            </span>
          )}

          {/* Forgotten badge */}
          {forgotten && (
            <span className="rounded-full bg-zinc-100 px-2 py-0.5 text-xs text-zinc-500 dark:bg-zinc-800 dark:text-zinc-400">
              Forgotten
            </span>
          )}
        </div>
      )}
    </div>
  );
}
