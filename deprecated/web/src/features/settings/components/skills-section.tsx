'use client';

import { Button } from '@/components/ui/button';
import { inputCls } from '@/components/ui/field';
import { Spinner } from '@/components/ui/spinner';
import type { RepoView } from '@/lib/api/job-api';
import { useOrgRepos } from '@/lib/api/job-queries';
import {
  useDeleteSkill,
  useForkSkill,
  useInstallSkill,
  useSaveSkill,
  useSkillFiles,
  useSkills,
  useUpdateSkill,
  type McpSurface,
  type Skill,
  type SkillProvenance,
  type SkillUpdatePolicy,
  type SystemSkill,
} from '@/lib/api/orgs';
import { cn } from '@/lib/cn';
import {
  AlertCircle,
  Bot,
  Check,
  Download,
  Eye,
  FileCode,
  GitBranch,
  GitFork,
  Lock,
  Plus,
  RefreshCw,
  ShieldCheck,
  Sparkles,
  Trash2,
  X,
} from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';

const SURFACE_META: { key: McpSurface; label: string; sub: string }[] = [
  { key: 'brain', label: 'Brain', sub: 'operator chat' },
  { key: 'build', label: 'Build turns', sub: 'coding sessions' },
  { key: 'review', label: 'Review', sub: 'review passes' },
];

/**
 * Skills — directory-based `SKILL.md` bundles the agent can load, in two writable scopes: **Organization**
 * (every repo/job) and **Repository** (one repo, overrides an org skill of the same name). A skill is
 * either `git` provenance (installed from a repo, auto-updatable) or `custom` (authored here, freely
 * editable — a single-file `SKILL.md`; heavier multi-file skills are authored in git/editor). This is a
 * manager + read-only viewer, not a multi-file web IDE. Owner-only writes (the server enforces it).
 */
export function SkillsSection({ orgId, role }: { orgId: string; role: string }) {
  const { data, isLoading, isError, refetch } = useSkills(orgId);
  const skills = data?.skills;
  const { data: repos } = useOrgRepos(orgId);
  const isOwner = role === 'owner';

  const [installOpen, setInstallOpen] = useState(false);
  const [editing, setEditing] = useState<Skill | 'new' | null>(null);
  const [viewing, setViewing] = useState<Skill | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<Skill | null>(null);

  const repoById = useMemo(() => {
    const m = new Map<string, RepoView>();
    for (const r of repos ?? []) m.set(r.id, r);
    return m;
  }, [repos]);

  const orgSkills = useMemo(() => (skills ?? []).filter((s) => s.scope === 'org'), [skills]);
  const repoGroups = useMemo(() => {
    const byScope = new Map<string, Skill[]>();
    for (const s of skills ?? []) {
      if (s.scope === 'org') continue;
      if (!byScope.has(s.scope)) byScope.set(s.scope, []);
      byScope.get(s.scope)!.push(s);
    }
    return [...byScope.entries()].sort(([a], [b]) => {
      const an = repoById.get(a)?.name ?? a;
      const bn = repoById.get(b)?.name ?? b;
      return an.localeCompare(bn);
    });
  }, [skills, repoById]);

  return (
    <>
      <h1 className="font-disp text-[22px] font-semibold tracking-[-0.01em] text-text">Skills</h1>
      <p className="mb-4 mt-1.5 max-w-160 text-[13px] leading-relaxed text-dim">
        Directory-based skill bundles the agent can load, in four layers:{' '}
        <b className="font-semibold text-text">Atlas built-in</b> and{' '}
        <b className="font-semibold text-text">Claude Code built-in</b> are read-only and always on;{' '}
        <b className="font-semibold text-text">Organization</b> skills apply to every repo &amp;
        job; <b className="font-semibold text-text">Repository</b> skills add to a single repo and
        override an org or built-in skill of the same name. Install from a git repo (auto-updatable)
        or author a custom one here.
      </p>

      {!isOwner ? (
        <div className="mb-4 flex items-center gap-2 rounded-md border border-border bg-surface-2 px-3 py-2.5 text-[11.5px] text-faint">
          <Lock size={13} />
          Read-only — only owners can install, edit, update, fork, or delete skills.
        </div>
      ) : null}

      {isLoading ? (
        <div className="mt-7 flex items-center gap-2 text-[12px] text-faint">
          <Spinner className="h-3 w-3" /> Loading skills…
        </div>
      ) : isError || !data ? (
        <div className="mt-7 flex items-start gap-3 rounded-lg border border-red-line bg-red-soft p-5">
          <AlertCircle size={17} className="mt-0.5 shrink-0 text-red" />
          <div className="flex-1">
            <div className="text-[13.5px] font-semibold text-red">Couldn’t load skills.</div>
            <div className="mt-0.5 text-[12px] leading-relaxed text-dim">
              The server didn’t respond. Check your connection and try again.
            </div>
          </div>
          <button
            type="button"
            onClick={() => void refetch()}
            className="shrink-0 rounded-md border border-border-2 bg-surface px-3.5 py-2 text-[12px] font-semibold text-text transition hover:bg-surface-2"
          >
            Retry
          </button>
        </div>
      ) : (
        <>
          <SystemSkillsGroup skills={data.system} />
          <BundledSkillsGroup names={data.bundled} />

          <div className="mb-5 flex items-center gap-2.5">
            <div className="font-disp text-[15px] font-semibold text-text">
              Organization &amp; Repository
            </div>
            <div className="h-px flex-1 bg-border" />
          </div>

          {isOwner ? (
            <div className="mb-5 flex items-center gap-2.5">
              <Button
                size="sm"
                variant="soft"
                icon={<Download size={14} />}
                onClick={() => setInstallOpen(true)}
              >
                Install from GitHub
              </Button>
              <Button
                size="sm"
                variant="soft"
                icon={<Plus size={14} />}
                onClick={() => setEditing('new')}
              >
                Create custom
              </Button>
            </div>
          ) : null}

          {data.skills.length === 0 ? (
            <div className="flex flex-col items-center rounded-lg border border-dashed border-border-2 bg-surface-2 px-7 py-10 text-center">
              <div className="mb-3.5 flex h-11 w-11 items-center justify-center rounded-xl border border-border-2 bg-surface text-faint">
                <Sparkles size={20} />
              </div>
              <div className="font-disp text-[15px] font-semibold text-text">No skills yet</div>
              <div className="mt-1.5 max-w-90 text-[12.5px] leading-relaxed text-dim">
                Install a skill from a GitHub repo, or author a custom one to give the agent a
                reusable playbook.
              </div>
            </div>
          ) : (
            <>
              <ScopeGroup
                orgId={orgId}
                title="Organization skills"
                skills={orgSkills}
                canManage={isOwner}
                onEdit={setEditing}
                onView={setViewing}
                onDelete={setDeleteTarget}
                emptyBody="No org-wide skills yet."
              />
              {repoGroups.map(([scope, list]) => {
                const repo = repoById.get(scope);
                return (
                  <ScopeGroup
                    key={scope}
                    orgId={orgId}
                    title={repo ? repo.name : `${scope}`}
                    disconnected={!repo}
                    skills={list}
                    canManage={isOwner}
                    onEdit={setEditing}
                    onView={setViewing}
                    onDelete={setDeleteTarget}
                  />
                );
              })}
            </>
          )}
        </>
      )}

      {installOpen ? (
        <InstallDialog orgId={orgId} repos={repos ?? []} onClose={() => setInstallOpen(false)} />
      ) : null}

      {editing ? (
        <SkillFormDialog
          orgId={orgId}
          existing={editing === 'new' ? null : editing}
          repos={repos ?? []}
          existingNames={(skills ?? [])
            .filter((s) => s.scope === (editing === 'new' ? 'org' : editing.scope))
            .map((s) => s.name)}
          onClose={() => setEditing(null)}
        />
      ) : null}

      {viewing ? (
        <ViewerDialog orgId={orgId} skill={viewing} onClose={() => setViewing(null)} />
      ) : null}

      {deleteTarget ? (
        <DeleteDialog orgId={orgId} skill={deleteTarget} onClose={() => setDeleteTarget(null)} />
      ) : null}
    </>
  );
}

function SystemSkillsGroup({ skills }: { skills: SystemSkill[] }) {
  return (
    <div className="mb-7">
      <SystemGroupHeader
        icon={<ShieldCheck size={13} />}
        title="Atlas built-in"
        count={skills.length}
      />
      {skills.length === 0 ? (
        <p className="text-[12px] text-faint">
          None shipped yet — Atlas's own built-in skills land here as they're authored. An org or
          repo skill of the same name always overrides one of these.
        </p>
      ) : (
        <div className="flex flex-col gap-2.5">
          {skills.map((s) => (
            <div key={s.name} className="rounded-lg border border-border bg-surface-2 px-4 py-3.5">
              <div className="flex items-center gap-2.5">
                <span className="font-mono text-[13px] font-semibold text-text">{s.name}</span>
                <span
                  className="rounded-sm border px-1.5 py-0.5 font-mono text-[9.5px] font-semibold uppercase tracking-[0.03em] text-green"
                  style={{
                    background: 'color-mix(in srgb, var(--green) 10%, transparent)',
                    borderColor: 'color-mix(in srgb, var(--green) 30%, transparent)',
                  }}
                >
                  managed
                </span>
                {s.git ? (
                  <span
                    className="flex items-center gap-1 rounded-sm border border-border-2 bg-surface-3 px-1.5 py-0.5 font-mono text-[9.5px] text-dim"
                    title={s.git.url}
                  >
                    <GitBranch size={9} /> git
                  </span>
                ) : null}
                {s.git && !s.synced ? (
                  <span className="rounded-sm border border-amber/30 bg-amber/10 px-1.5 py-0.5 font-mono text-[9.5px] font-semibold uppercase tracking-[0.03em] text-amber">
                    pending sync
                  </span>
                ) : null}
              </div>
              <div className="mt-1.5 text-[12px] leading-relaxed text-dim">{s.description}</div>
              <div className="mt-2.5 flex flex-wrap items-center gap-1.5">
                <span className="font-mono text-[8.5px] tracking-[0.08em] text-faint">
                  SURFACES
                </span>
                {s.surfaces.map((surf) => (
                  <span
                    key={surf}
                    className="rounded-sm border border-border-2 bg-surface-3 px-1.5 py-0.5 font-mono text-[9.5px] text-dim"
                  >
                    {surf}
                  </span>
                ))}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function BundledSkillsGroup({ names }: { names: string[] }) {
  return (
    <div className="mb-7">
      <SystemGroupHeader
        icon={<Bot size={13} />}
        title="Claude Code built-in"
        count={names.length}
      />
      <p className="mb-2.5 text-[11.5px] leading-relaxed text-faint">
        Bundled with the Claude Code CLI itself — already active for every turn, not managed here
        (the exact set depends on the CLI version Atlas runs).
      </p>
      {names.length === 0 ? (
        <p className="text-[12px] text-faint">None detected.</p>
      ) : (
        <div className="flex flex-wrap gap-1.5">
          {names.map((n) => (
            <span
              key={n}
              className="rounded-sm border border-border-2 bg-surface-3 px-2 py-1 font-mono text-[11px] text-dim"
            >
              {n}
            </span>
          ))}
        </div>
      )}
    </div>
  );
}

function SystemGroupHeader({
  icon,
  title,
  count,
}: {
  icon: React.ReactNode;
  title: string;
  count: number;
}) {
  return (
    <div className="mb-2.5 flex items-center gap-2.5">
      <span className="text-faint">{icon}</span>
      <div className="font-disp text-[15px] font-semibold text-text">{title}</div>
      <span
        className="flex items-center gap-1.5 rounded-full border px-2.5 py-0.5 font-mono text-[9px] text-green"
        style={{
          background: 'var(--green-soft)',
          borderColor: 'color-mix(in srgb, var(--green) 30%, transparent)',
        }}
      >
        <span className="h-1.25 w-1.25 rounded-full bg-green" />
        always on
      </span>
      <CountPill n={count} />
      <div className="h-px flex-1 bg-border" />
      <span className="font-mono text-[9px] text-faint">read-only</span>
    </div>
  );
}

function ScopeGroup({
  orgId,
  title,
  disconnected = false,
  skills,
  canManage,
  onEdit,
  onView,
  onDelete,
  emptyBody,
}: {
  orgId: string;
  title: string;
  disconnected?: boolean;
  skills: Skill[];
  canManage: boolean;
  onEdit: (s: Skill) => void;
  onView: (s: Skill) => void;
  onDelete: (s: Skill) => void;
  emptyBody?: string;
}) {
  if (skills.length === 0 && !emptyBody) return null;
  const gitSkills = skills.filter((s) => s.provenance !== 'custom');
  const customSkills = skills.filter((s) => s.provenance === 'custom');

  return (
    <div className="mb-7">
      <div className="mb-2.5 flex items-center gap-2.5">
        <div className="font-disp text-[15px] font-semibold text-text">{title}</div>
        <CountPill n={skills.length} />
        {disconnected ? (
          <span className="rounded-full border border-border-2 bg-surface-2 px-2 py-0.5 font-mono text-[9px] text-faint">
            disconnected
          </span>
        ) : null}
        <div className="h-px flex-1 bg-border" />
      </div>

      {skills.length === 0 ? (
        <p className="text-[12px] text-faint">{emptyBody}</p>
      ) : (
        <div className="flex flex-col gap-2.5">
          {gitSkills.length > 0 ? (
            <>
              <GroupLabel>Installed</GroupLabel>
              {gitSkills.map((s) => (
                <SkillRow
                  key={s.name}
                  orgId={orgId}
                  skill={s}
                  canManage={canManage}
                  onEdit={onEdit}
                  onView={onView}
                  onDelete={onDelete}
                />
              ))}
            </>
          ) : null}
          {customSkills.length > 0 ? (
            <>
              <GroupLabel>Custom</GroupLabel>
              {customSkills.map((s) => (
                <SkillRow
                  key={s.name}
                  orgId={orgId}
                  skill={s}
                  canManage={canManage}
                  onEdit={onEdit}
                  onView={onView}
                  onDelete={onDelete}
                />
              ))}
            </>
          ) : null}
        </div>
      )}
    </div>
  );
}

function GroupLabel({ children }: { children: React.ReactNode }) {
  return <div className="mt-0.5 font-mono text-[9px] tracking-[0.14em] text-faint">{children}</div>;
}

function CountPill({ n }: { n: number }) {
  return (
    <span className="rounded-full border border-border-2 bg-surface-2 px-2 py-0.5 font-mono text-[9px] text-dim">
      {n}
    </span>
  );
}

function SkillRow({
  orgId,
  skill,
  canManage,
  onEdit,
  onView,
  onDelete,
}: {
  orgId: string;
  skill: Skill;
  canManage: boolean;
  onEdit: (s: Skill) => void;
  onView: (s: Skill) => void;
  onDelete: (s: Skill) => void;
}) {
  const update = useUpdateSkill(orgId);
  const fork = useForkSkill(orgId);

  return (
    <div
      className="rounded-lg border border-border bg-surface px-4 py-3.5"
      style={{ opacity: skill.enabled ? 1 : 0.62 }}
    >
      <div className="flex items-start gap-3.5">
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <span className="font-mono text-[13px] font-semibold text-text">{skill.name}</span>
            <ProvenanceBadge provenance={skill.provenance} />
            {skill.updateAvailable ? <UpdateAvailableBadge /> : null}
            {skill.forkedFrom ? (
              <span className="flex items-center gap-1 rounded-full border border-border-2 bg-surface-2 px-2 py-0.5 font-mono text-[9px] text-faint">
                <GitFork size={10} /> forked from {skill.forkedFrom}
              </span>
            ) : null}
            {!skill.enabled ? (
              <span className="rounded-full border border-border-2 bg-surface-2 px-2 py-0.5 font-mono text-[9px] text-faint">
                disabled
              </span>
            ) : null}
          </div>

          <div className="mt-1.5 line-clamp-2 text-[12px] leading-relaxed text-dim">
            {skill.description}
          </div>

          {skill.provenance === 'git' && skill.sourceUrl ? (
            <div className="mt-1.5 flex min-w-0 items-center gap-1.5 font-mono text-[11px] text-faint">
              <GitBranch size={11} className="shrink-0" />
              <span className="truncate">
                {skill.sourceUrl}
                {skill.sourceRef ? `@${skill.sourceRef}` : ''}
                {skill.sourceSubpath ? `/${skill.sourceSubpath}` : ''}
              </span>
            </div>
          ) : null}

          <div className="mt-2.5 flex flex-wrap items-center gap-1.5">
            <span className="font-mono text-[8.5px] tracking-[0.08em] text-faint">SURFACES</span>
            {skill.surfaces.map((s) => (
              <span
                key={s}
                className="rounded-sm border border-border-2 bg-surface-3 px-1.5 py-0.5 font-mono text-[9.5px] text-dim"
              >
                {s}
              </span>
            ))}
          </div>
        </div>

        <div className="flex shrink-0 flex-col items-end gap-2.5">
          <button
            type="button"
            onClick={() => onView(skill)}
            className="flex items-center gap-1.5 rounded-sm border border-border-2 px-2.5 py-1.5 text-[11px] font-semibold text-dim transition hover:bg-surface-2"
          >
            <Eye size={12} /> View
          </button>

          {canManage ? (
            <div className="flex items-center gap-1.5">
              {skill.provenance === 'git' && skill.updateAvailable ? (
                <button
                  type="button"
                  onClick={() => update.mutate({ scope: skill.scope, name: skill.name })}
                  disabled={update.isPending}
                  className="flex items-center gap-1.5 rounded-sm border border-border-2 px-2.5 py-1.5 text-[11px] font-semibold text-dim transition hover:bg-surface-2 disabled:opacity-60"
                >
                  {update.isPending ? <Spinner className="h-2.5 w-2.5" /> : <RefreshCw size={12} />}
                  Update
                </button>
              ) : null}
              {skill.provenance === 'git' ? (
                <button
                  type="button"
                  onClick={() => fork.mutate({ scope: skill.scope, name: skill.name })}
                  disabled={fork.isPending}
                  className="flex items-center gap-1.5 rounded-sm border border-border-2 px-2.5 py-1.5 text-[11px] font-semibold text-dim transition hover:bg-surface-2 disabled:opacity-60"
                >
                  {fork.isPending ? <Spinner className="h-2.5 w-2.5" /> : <GitFork size={12} />}
                  Fork
                </button>
              ) : null}
              <button
                type="button"
                onClick={() => onEdit(skill)}
                className="rounded-sm border border-border-2 px-2.5 py-1.5 text-[11px] font-semibold text-dim transition hover:bg-surface-2"
              >
                Edit
              </button>
              <button
                type="button"
                onClick={() => onDelete(skill)}
                className="rounded-sm border border-border-2 px-2.5 py-1.5 text-[11px] font-semibold text-dim transition hover:text-red"
              >
                Delete
              </button>
            </div>
          ) : null}
        </div>
      </div>
      {fork.isSuccess ? (
        <div className="mt-2.5 text-[11px] text-green">
          Forked to “{fork.data?.name}” — find it under Custom below.
        </div>
      ) : null}
    </div>
  );
}

const PROVENANCE_HUE: Record<SkillProvenance, string> = {
  git: 'blue',
  custom: 'purple',
  managed: 'green',
};

function ProvenanceBadge({ provenance }: { provenance: SkillProvenance }) {
  const hue = PROVENANCE_HUE[provenance];
  return (
    <span
      className="rounded-sm border px-1.5 py-0.5 font-mono text-[9.5px] font-semibold uppercase tracking-[0.03em]"
      style={{
        color: `var(--${hue})`,
        background: `color-mix(in srgb, var(--${hue}) 10%, transparent)`,
        borderColor: `color-mix(in srgb, var(--${hue}) 30%, transparent)`,
      }}
    >
      {provenance}
    </span>
  );
}

function UpdateAvailableBadge() {
  return (
    <span
      className="flex items-center gap-1 rounded-full border px-2 py-0.5 font-mono text-[9px] text-amber"
      style={{
        background: 'color-mix(in srgb, var(--amber) 10%, transparent)',
        borderColor: 'color-mix(in srgb, var(--amber) 30%, transparent)',
      }}
    >
      <RefreshCw size={10} /> update available
    </span>
  );
}

function InstallDialog({
  orgId,
  repos,
  onClose,
}: {
  orgId: string;
  repos: RepoView[];
  onClose: () => void;
}) {
  const install = useInstallSkill(orgId);
  const [scope, setScope] = useState('org');
  const [sourceUrl, setSourceUrl] = useState('');
  const [ref, setRef] = useState('');
  const [subpath, setSubpath] = useState('');
  const [updatePolicy, setUpdatePolicy] = useState<SkillUpdatePolicy>('track-ref');
  const [err, setErr] = useState('');

  const canInstall = sourceUrl.trim().length > 0 && !install.isPending;

  async function submit() {
    if (!canInstall) return;
    try {
      await install.mutateAsync({
        scope,
        sourceUrl: sourceUrl.trim(),
        ref: ref.trim() || undefined,
        subpath: subpath.trim() || undefined,
        updatePolicy,
      });
      onClose();
    } catch (e) {
      setErr((e as Error)?.message || 'Could not install.');
    }
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4"
      onMouseDown={onClose}
    >
      <div
        role="dialog"
        aria-modal="true"
        className="flex max-h-[88vh] w-full max-w-130 flex-col overflow-hidden rounded-xl border border-border bg-panel shadow-xl"
        onMouseDown={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between border-b border-border px-5 py-3.5">
          <div className="text-[14px] font-semibold text-text">Install from GitHub</div>
          <button
            type="button"
            onClick={onClose}
            className="rounded-md p-1 text-faint transition hover:bg-surface-2 hover:text-text"
          >
            <X size={16} />
          </button>
        </div>

        <div className="flex-1 overflow-auto px-5 py-4">
          <FormLabel>
            Source URL <span className="text-accent">*</span>
          </FormLabel>
          <input
            value={sourceUrl}
            onChange={(e) => setSourceUrl(e.target.value)}
            placeholder="https://github.com/owner/repo"
            className={cn(inputCls, 'font-mono text-[12.5px]')}
          />
          <div className="mt-1.5 text-[10.5px] leading-relaxed text-faint">
            A single skill dir (with `SKILL.md`), or a marketplace repo — its
            `.claude-plugin/marketplace.json` expands into every skill it lists.
          </div>

          <FormLabel className="mt-4">Ref (optional)</FormLabel>
          <input
            value={ref}
            onChange={(e) => setRef(e.target.value)}
            placeholder="main (defaults to the remote's default branch)"
            className={cn(inputCls, 'font-mono text-[12.5px]')}
          />

          <FormLabel className="mt-4">Subpath (optional)</FormLabel>
          <input
            value={subpath}
            onChange={(e) => setSubpath(e.target.value)}
            placeholder="skills/my-skill, or a marketplace dir"
            className={cn(inputCls, 'font-mono text-[12.5px]')}
          />

          <FormLabel className="mt-4">Scope</FormLabel>
          <select
            value={scope}
            onChange={(e) => setScope(e.target.value)}
            className={cn(inputCls, 'cursor-pointer text-[12.5px]')}
          >
            <option value="org">Organization (every repo &amp; job)</option>
            {repos.map((r) => (
              <option key={r.id} value={r.id}>
                {r.name}
              </option>
            ))}
          </select>

          <FormLabel className="mt-4">Update policy</FormLabel>
          <select
            value={updatePolicy}
            onChange={(e) => setUpdatePolicy(e.target.value as SkillUpdatePolicy)}
            className={cn(inputCls, 'cursor-pointer text-[12.5px]')}
          >
            <option value="track-ref">Track ref — auto-update when the source moves</option>
            <option value="pinned">Pinned — badge only, apply manually</option>
            <option value="manual">Manual — never auto-checked</option>
          </select>

          {err ? (
            <div className="mt-3 rounded-md border border-red-line bg-red-soft px-3 py-2 text-[11.5px] text-red">
              {err}
            </div>
          ) : null}
        </div>

        <div className="flex items-center justify-end gap-2 border-t border-border px-5 py-3">
          <Button size="sm" variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button
            size="sm"
            disabled={!canInstall}
            loading={install.isPending}
            loadingText="Installing…"
            icon={<Download size={14} />}
            onClick={submit}
          >
            Install
          </Button>
        </div>
      </div>
    </div>
  );
}

function slugify(name: string): string {
  return name
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 64);
}

function SkillFormDialog({
  orgId,
  existing,
  repos,
  existingNames,
  onClose,
}: {
  orgId: string;
  existing: Skill | null;
  repos: RepoView[];
  existingNames: string[];
  onClose: () => void;
}) {
  const save = useSaveSkill(orgId);
  const isEdit = existing !== null;
  // A brand-new skill is always custom-authored (installing is the separate GitHub flow).
  const isCustom = existing ? existing.provenance === 'custom' : true;

  const [scope, setScope] = useState(existing?.scope ?? 'org');
  const [name, setName] = useState(existing?.name ?? '');
  const [slugTouched, setSlugTouched] = useState(isEdit);
  const [description, setDescription] = useState(existing?.description ?? '');
  const [surfaces, setSurfaces] = useState<McpSurface[]>(existing?.surfaces ?? ['brain', 'build']);
  const [enabled, setEnabled] = useState(existing?.enabled ?? true);
  const [updatePolicy, setUpdatePolicy] = useState<SkillUpdatePolicy>(
    existing?.updatePolicy ?? 'track-ref',
  );
  const [nameErr, setNameErr] = useState('');
  const [formErr, setFormErr] = useState('');

  const effectiveName = isEdit ? existing.name : slugify(name);

  // Editing a custom skill needs its current SKILL.md to prefill the body textarea (the list row carries
  // no content). Fetch it lazily, once, on open.
  const filesQ = useSkillFiles(
    orgId,
    existing?.scope ?? '',
    existing?.name ?? '',
    Boolean(isEdit && isCustom),
  );
  const [body, setBody] = useState('');
  const [bodyTouched, setBodyTouched] = useState(false);
  useEffect(() => {
    if (isEdit && isCustom && filesQ.data && !bodyTouched) {
      setBody(filesQ.data.skillMd ?? '');
    }
  }, [filesQ.data, isEdit, isCustom, bodyTouched]);

  function toggleSurface(s: McpSurface) {
    setSurfaces((cur) => (cur.includes(s) ? cur.filter((x) => x !== s) : [...cur, s]));
  }

  const canSave =
    effectiveName.length > 0 &&
    description.trim().length > 0 &&
    surfaces.length > 0 &&
    (isCustom ? body.trim().length > 0 : true) &&
    !save.isPending &&
    !(isEdit && isCustom && filesQ.isLoading);

  function submit() {
    if (!isEdit) {
      if (!/^[a-z][a-z0-9-]*$/.test(effectiveName)) {
        setNameErr('Lowercase letters, digits, and dashes only — starting with a letter.');
        return;
      }
      if (existingNames.includes(effectiveName)) {
        setNameErr('A skill with that name already exists at this scope.');
        return;
      }
    }
    setNameErr('');
    if (surfaces.length === 0) {
      setFormErr('Pick at least one surface it applies to.');
      return;
    }
    setFormErr('');
    save.mutate(
      {
        scope,
        name: effectiveName,
        body: {
          description: description.trim(),
          provenance: isCustom ? 'custom' : undefined,
          surfaces,
          reviewForTypes: existing?.reviewForTypes,
          reviewForGlobs: existing?.reviewForGlobs,
          enabled,
          updatePolicy: isCustom ? undefined : updatePolicy,
          body: isCustom ? body : undefined,
        },
      },
      {
        onSuccess: onClose,
        onError: (e) => setFormErr((e as Error)?.message || 'Could not save.'),
      },
    );
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4"
      onMouseDown={onClose}
    >
      <div
        role="dialog"
        aria-modal="true"
        className="flex max-h-[88vh] w-full max-w-155 flex-col overflow-hidden rounded-xl border border-border bg-panel shadow-xl"
        onMouseDown={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between border-b border-border px-5 py-3.5">
          <div className="text-[14px] font-semibold text-text">
            {isEdit ? `Edit “${existing.name}”` : 'New custom skill'}
          </div>
          <button
            type="button"
            onClick={onClose}
            className="rounded-md p-1 text-faint transition hover:bg-surface-2 hover:text-text"
          >
            <X size={16} />
          </button>
        </div>

        <div className="flex-1 overflow-auto px-5 py-4">
          <FormLabel>
            Name <span className="text-accent">*</span>
          </FormLabel>
          <input
            value={isEdit ? existing.name : name}
            onChange={(e) => {
              setSlugTouched(true);
              setName(e.target.value);
            }}
            disabled={isEdit}
            placeholder="deploy-runbook"
            className={cn(
              inputCls,
              'font-mono text-[12.5px] font-semibold',
              isEdit && 'opacity-60',
            )}
          />
          {!isEdit && slugTouched ? (
            <div className="mt-1.5 font-mono text-[10.5px] text-faint">
              Registers as <span className="text-dim">{effectiveName || '<name>'}</span>
            </div>
          ) : null}
          {nameErr ? <div className="mt-1.5 text-[11px] text-red">{nameErr}</div> : null}

          <FormLabel className="mt-4">Scope</FormLabel>
          <select
            value={scope}
            onChange={(e) => setScope(e.target.value)}
            disabled={isEdit}
            className={cn(inputCls, 'cursor-pointer text-[12.5px]', isEdit && 'opacity-60')}
          >
            <option value="org">Organization (every repo &amp; job)</option>
            {repos.map((r) => (
              <option key={r.id} value={r.id}>
                {r.name}
              </option>
            ))}
          </select>

          <FormLabel className="mt-4">
            Description <span className="text-accent">*</span>
          </FormLabel>
          <input
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            placeholder="Use when deploying a hotfix to production"
            className={cn(inputCls, 'text-[13px]')}
          />
          <div className="mt-1.5 text-[10.5px] leading-relaxed text-faint">
            What the agent reads to decide whether this skill applies — written into the `SKILL.md`
            frontmatter.
          </div>

          {isCustom ? (
            <>
              <FormLabel className="mt-4">
                SKILL.md body <span className="text-accent">*</span>
              </FormLabel>
              {isEdit && filesQ.isLoading ? (
                <div className="flex items-center gap-2 py-3 text-[12px] text-faint">
                  <Spinner className="h-3 w-3" /> Loading current content…
                </div>
              ) : (
                <textarea
                  value={body}
                  onChange={(e) => {
                    setBodyTouched(true);
                    setBody(e.target.value);
                  }}
                  className={cn(
                    inputCls,
                    'h-55 resize-y py-2.5 font-mono text-[12px] leading-relaxed',
                  )}
                  placeholder={'## When to use this\n\n…\n\n## Steps\n\n1. …'}
                />
              )}
              <div className="mt-1.5 text-[10.5px] leading-relaxed text-faint">
                Single-file only — supporting `references/`, `scripts/`, or binary assets need
                git/editor authoring, then Install.
              </div>
            </>
          ) : (
            <>
              <FormLabel className="mt-4">Update policy</FormLabel>
              <select
                value={updatePolicy}
                onChange={(e) => setUpdatePolicy(e.target.value as SkillUpdatePolicy)}
                className={cn(inputCls, 'cursor-pointer text-[12.5px]')}
              >
                <option value="track-ref">Track ref — auto-update when the source moves</option>
                <option value="pinned">Pinned — badge only, apply manually</option>
                <option value="manual">Manual — never auto-checked</option>
              </select>
              <div className="mt-1.5 text-[10.5px] leading-relaxed text-faint">
                Installed from {existing?.sourceUrl}
                {existing?.sourceRef ? `@${existing.sourceRef}` : ''} — its `SKILL.md` isn’t
                editable here; Fork it to a custom copy first.
              </div>
            </>
          )}

          <FormLabel className="mt-4">Applies to</FormLabel>
          <div className="flex flex-wrap gap-2">
            {SURFACE_META.map(({ key, label, sub }) => {
              const on = surfaces.includes(key);
              return (
                <button
                  key={key}
                  type="button"
                  onClick={() => toggleSurface(key)}
                  className="flex min-w-35 flex-1 items-center gap-2.5 rounded-md border border-border-2 bg-surface-2 px-3 py-2.5 text-left transition"
                >
                  <span
                    className="flex h-4.25 w-4.25 shrink-0 items-center justify-center rounded-[5px] border"
                    style={{
                      background: on ? 'var(--accent)' : 'transparent',
                      borderColor: on ? 'var(--accent)' : 'var(--border-2)',
                    }}
                  >
                    {on ? <Check size={11} strokeWidth={3.2} color="#fff" /> : null}
                  </span>
                  <span>
                    <span className="block text-[12px] font-semibold text-text">{label}</span>
                    <span className="block text-[10px] text-faint">{sub}</span>
                  </span>
                </button>
              );
            })}
          </div>

          <div className="mt-4 flex items-center gap-2.5">
            <button
              type="button"
              onClick={() => setEnabled((e) => !e)}
              className="relative h-4.75 w-8.5 shrink-0 rounded-full transition-colors"
              style={{
                background: enabled ? 'var(--accent)' : 'var(--border-2)',
              }}
              aria-pressed={enabled}
            >
              <span
                className="absolute top-0.5 h-3.75 w-3.75 rounded-full bg-white transition-all"
                style={{
                  left: enabled ? '17px' : '2px',
                  boxShadow: '0 1px 3px rgba(0,0,0,.3)',
                }}
              />
            </button>
            <span className="text-[12.5px] font-semibold text-text">Enabled</span>
            <span className="text-[11px] text-faint">Agent sessions can load this skill.</span>
          </div>

          {formErr ? (
            <div className="mt-3 rounded-md border border-red-line bg-red-soft px-3 py-2 text-[11.5px] text-red">
              {formErr}
            </div>
          ) : null}
        </div>

        <div className="flex items-center justify-end gap-2 border-t border-border px-5 py-3">
          <Button size="sm" variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button
            size="sm"
            disabled={!canSave}
            loading={save.isPending}
            loadingText="Saving…"
            onClick={submit}
          >
            {isEdit ? 'Save changes' : 'Create skill'}
          </Button>
        </div>
      </div>
    </div>
  );
}

function ViewerDialog({
  orgId,
  skill,
  onClose,
}: {
  orgId: string;
  skill: Skill;
  onClose: () => void;
}) {
  const { data, isLoading, isError, refetch } = useSkillFiles(orgId, skill.scope, skill.name, true);

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4"
      onMouseDown={onClose}
    >
      <div
        role="dialog"
        aria-modal="true"
        className="flex max-h-[85vh] w-full max-w-180 flex-col overflow-hidden rounded-xl border border-border bg-panel shadow-xl"
        onMouseDown={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between border-b border-border px-5 py-3.5">
          <div className="flex items-center gap-2">
            <FileCode size={15} className="text-faint" />
            <span className="font-mono text-[13px] font-semibold text-text">{skill.name}</span>
            <ProvenanceBadge provenance={skill.provenance} />
          </div>
          <button
            type="button"
            onClick={onClose}
            className="rounded-md p-1 text-faint transition hover:bg-surface-2 hover:text-text"
          >
            <X size={16} />
          </button>
        </div>

        <div className="flex-1 overflow-auto px-5 py-4">
          {isLoading ? (
            <div className="flex items-center gap-2 py-6 text-[12px] text-faint">
              <Spinner className="h-3 w-3" /> Loading…
            </div>
          ) : isError || !data ? (
            <div className="flex items-start gap-3 rounded-lg border border-red-line bg-red-soft p-4">
              <AlertCircle size={16} className="mt-0.5 shrink-0 text-red" />
              <div className="flex-1 text-[12px] text-red">Couldn’t load this skill’s files.</div>
              <button
                type="button"
                onClick={() => void refetch()}
                className="shrink-0 rounded-md border border-border-2 bg-surface px-2.5 py-1 text-[11px] font-semibold text-text"
              >
                Retry
              </button>
            </div>
          ) : (
            <>
              <div className="mb-1.5 font-mono text-[9px] tracking-[0.14em] text-faint">
                FILES ({data.files.length})
              </div>
              {data.files.length === 0 ? (
                <p className="mb-4 text-[12px] text-faint">Nothing on disk for this skill.</p>
              ) : (
                <div className="mb-4 flex flex-col gap-0.5 rounded-md border border-border bg-surface-2 p-2.5">
                  {data.files.map((f) => (
                    <div
                      key={f}
                      className="flex items-center gap-1.5 font-mono text-[11.5px] text-dim"
                      style={{
                        paddingLeft: `${(f.split('/').length - 1) * 14}px`,
                      }}
                    >
                      <FileCode size={11} className="shrink-0 text-faint" />
                      <span className="truncate">{f.split('/').at(-1)}</span>
                    </div>
                  ))}
                </div>
              )}

              <div className="mb-1.5 font-mono text-[9px] tracking-[0.14em] text-faint">
                SKILL.MD
              </div>
              <pre className="max-h-70 overflow-auto whitespace-pre-wrap rounded-md border border-border bg-surface-2 p-3 text-[11.5px] leading-relaxed text-dim">
                {data.skillMd ?? '(no SKILL.md on disk)'}
              </pre>
            </>
          )}
        </div>

        <div className="flex items-center justify-end border-t border-border px-5 py-3">
          <Button size="sm" variant="ghost" onClick={onClose}>
            Close
          </Button>
        </div>
      </div>
    </div>
  );
}

function DeleteDialog({
  orgId,
  skill,
  onClose,
}: {
  orgId: string;
  skill: Skill;
  onClose: () => void;
}) {
  const del = useDeleteSkill(orgId);
  const scopeLabel = skill.scope === 'org' ? 'this organization' : 'this repo';

  async function confirm() {
    try {
      await del.mutateAsync({ scope: skill.scope, name: skill.name });
      onClose();
    } catch {
      onClose();
    }
  }

  return (
    <div
      onClick={onClose}
      className="fixed inset-0 z-50 flex items-start justify-center pt-37.5"
      style={{ background: 'rgba(10,12,16,.5)', backdropFilter: 'blur(3px)' }}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        className="w-107.5 max-w-[90%] overflow-hidden rounded-lg border border-border-2 bg-panel"
        style={{ boxShadow: '0 30px 80px rgba(0,0,0,.4)' }}
      >
        <div className="p-5 pb-4">
          <div className="mb-3 flex items-center gap-3">
            <div
              className="flex h-8.5 w-8.5 shrink-0 items-center justify-center rounded-lg text-red"
              style={{
                background: 'var(--red-soft)',
                border: '1px solid color-mix(in srgb, var(--red) 40%, transparent)',
              }}
            >
              <Trash2 size={17} />
            </div>
            <div className="font-disp text-[16px] font-semibold text-text">
              Delete {skill.name}?
            </div>
          </div>
          <div className="text-[12.5px] leading-relaxed text-dim">
            Removes this skill from {scopeLabel} — its registry row AND its files on disk. Agent
            sessions will no longer see it. This can’t be undone.
          </div>
        </div>
        <div className="flex items-center justify-end gap-2 border-t border-border bg-surface-2 px-5 py-3.5">
          <button
            type="button"
            onClick={onClose}
            className="rounded-md border border-border-2 px-3.5 py-2 text-[12.5px] font-medium text-dim transition hover:bg-surface"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={confirm}
            disabled={del.isPending}
            className="flex items-center gap-2 rounded-md px-4 py-2 text-[12.5px] font-semibold text-white transition hover:brightness-105 disabled:opacity-60"
            style={{ background: 'var(--red)' }}
          >
            {del.isPending ? <Spinner className="h-3 w-3" /> : null}
            Delete skill
          </button>
        </div>
      </div>
    </div>
  );
}

function FormLabel({
  children,
  className = '',
}: {
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <label className={`mb-2 block text-[12px] font-medium text-dim ${className}`}>{children}</label>
  );
}
