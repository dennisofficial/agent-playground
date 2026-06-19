'use client';

import type { PlanView, SectionView } from '@workspace/shared';
import { PlanMarkdown } from '@/components/plan/markdown';
import { DependencyGraph } from '@/components/plan/dependency-graph';
import { SectionPhaseTimeline } from '@/components/plan/section-phase-timeline';
import { statusBadgeClass } from '@/components/plan/status';

/**
 * Renders a {@link PlanView}: a header with the ticket's at-a-glance status, then the plan content.
 * For a feature pipeline, content is the per-section archived plans (each may carry its own
 * ```mermaid diagrams); otherwise it's the single current task plan. The deterministic, system-derived
 * views (phase timeline + dependency graph) are slotted in above the prose.
 */
export function PlanViewer({ plan }: { plan: PlanView }) {
  const { task, currentPlan, pipeline } = plan;
  const sections = pipeline?.sections ?? [];
  const plannedSections = sections.filter((s) => s.planMd);
  const hasPipelinePlans = plannedSections.length > 0;

  return (
    <article className="flex flex-col gap-6">
      {/* Header */}
      <header className="border-b border-zinc-200 pb-4 dark:border-zinc-800">
        <div className="flex flex-wrap items-center gap-3">
          <h1 className="text-2xl font-semibold text-black dark:text-zinc-50">
            <span className="text-zinc-400 dark:text-zinc-500">#{task.id}</span> {task.title}
          </h1>
          <StatusBadge status={task.status} />
        </div>
        <div className="mt-2 flex flex-wrap items-center gap-x-4 gap-y-1 text-sm text-zinc-500 dark:text-zinc-400">
          <span>
            project <span className="font-medium text-zinc-700 dark:text-zinc-300">{task.project}</span>
          </span>
          {task.assignee && (
            <span>
              owner <span className="font-medium capitalize text-zinc-700 dark:text-zinc-300">{task.assignee}</span>
            </span>
          )}
          {pipeline && (
            <span>
              pipeline <span className="font-medium text-zinc-700 dark:text-zinc-300">{pipeline.kind}</span>{' '}
              <StatusBadge status={pipeline.status} />
            </span>
          )}
          {currentPlan?.prUrl && (
            <a
              href={currentPlan.prUrl}
              target="_blank"
              rel="noreferrer"
              className="font-medium text-blue-600 underline hover:text-blue-500 dark:text-blue-400"
            >
              Pull request →
            </a>
          )}
        </div>
        {task.description && (
          <p className="mt-3 text-sm text-zinc-600 dark:text-zinc-300">{task.description}</p>
        )}
      </header>

      {/* Feature overview (the whole-feature intent Atlas + Dennis agreed on) */}
      {pipeline?.overview && (
        <section>
          <SectionLabel>Overview</SectionLabel>
          <div className="rounded-lg border border-zinc-200 bg-white p-4 dark:border-zinc-800 dark:bg-zinc-950">
            <PlanMarkdown markdown={pipeline.overview} />
          </div>
        </section>
      )}

      {/* System-derived views: deterministic, straight from the DB (always accurate). */}
      {sections.length > 0 && (
        <section className="flex flex-col gap-4">
          <div>
            <SectionLabel>Progress</SectionLabel>
            <div className="mt-2">
              <SectionPhaseTimeline sections={sections} />
            </div>
          </div>
          {sections.length >= 2 && (
            <div>
              <SectionLabel>Section dependencies</SectionLabel>
              <DependencyGraph sections={sections} />
            </div>
          )}
        </section>
      )}

      {/* Plan content */}
      {hasPipelinePlans ? (
        <div className="flex flex-col gap-6">
          {sections.map((s) => (
            <SectionPlan key={s.id} section={s} />
          ))}
        </div>
      ) : currentPlan ? (
        <section>
          <SectionLabel>Plan</SectionLabel>
          <div className="rounded-lg border border-zinc-200 bg-white p-5 dark:border-zinc-800 dark:bg-zinc-950">
            <PlanMarkdown markdown={currentPlan.planMd} />
          </div>
        </section>
      ) : (
        <div className="rounded-xl border border-zinc-200 bg-white p-6 text-sm text-zinc-500 dark:border-zinc-800 dark:bg-zinc-950 dark:text-zinc-400">
          No plan has been written for this ticket yet.
        </div>
      )}
    </article>
  );
}

function SectionPlan({ section }: { section: SectionView }) {
  return (
    <section>
      <div className="mb-2 flex items-center gap-2">
        <SectionLabel>
          <span className="capitalize">{section.name}</span>
        </SectionLabel>
        <StatusBadge status={section.status} />
      </div>
      <div className="rounded-lg border border-zinc-200 bg-white p-5 dark:border-zinc-800 dark:bg-zinc-950">
        {section.planMd ? (
          <PlanMarkdown markdown={section.planMd} />
        ) : (
          <p className="text-sm text-zinc-400 dark:text-zinc-500">
            {section.brief ? `${section.brief} — not yet planned.` : 'Not yet planned.'}
          </p>
        )}
      </div>
    </section>
  );
}

function SectionLabel({ children }: { children: React.ReactNode }) {
  return (
    <h2 className="text-xs font-semibold uppercase tracking-wide text-zinc-400 dark:text-zinc-500">
      {children}
    </h2>
  );
}

function StatusBadge({ status }: { status: string }) {
  return (
    <span
      className={`inline-block rounded-full px-2 py-0.5 text-xs font-medium ${statusBadgeClass(status)}`}
    >
      {status.replace(/_/g, ' ')}
    </span>
  );
}
