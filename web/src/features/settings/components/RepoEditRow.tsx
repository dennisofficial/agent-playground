'use client';
import { BranchPicker } from '@/components/branch-picker';
import { Spinner } from '@/components/ui/spinner';
import type { RepoView } from '@/lib/api/job-api';
import { useUpdateRepoMutation } from '@/redux/query/api/repo.api';
import { type AutoMergeMethod, AUTO_MERGE_METHODS } from '@workspace/shared';
import { useState } from 'react';

export function RepoEditRow({
    orgId, repo, onClose, onError,
}: {
    orgId: string;
    repo: RepoView;
    onClose: () => void;
    onError: (text: string) => void;
}) {
    const [update, updateState] = useUpdateRepoMutation();
    const [name, setName] = useState(repo.name);
    const [branch, setBranch] = useState(repo.defaultBranch);
    const [branchPrefix, setBranchPrefix] = useState(repo.branchPrefix ?? '');
    const [mergeMethod, setMergeMethod] = useState<AutoMergeMethod>(repo.defaultAutoMergeMethod);
    const [deleteBranch, setDeleteBranch] = useState(repo.defaultAutoMergeDeleteBranch);

    async function save() {
        if (updateState.isLoading) return;
        try {
            await update({
                repoId: repo.id,
                body: {
                    name: name.trim() || repo.name,
                    defaultBranch: branch.trim() || repo.defaultBranch,
                    // Empty clears the override back to the neutral default.
                    branchPrefix: branchPrefix.trim(),
                    defaultAutoMergeMethod: mergeMethod,
                    defaultAutoMergeDeleteBranch: deleteBranch,
                },
            }).unwrap();
            onClose();
        } catch (e) {
            onError((e as Error)?.message || 'Could not save changes.');
        }
    }

    return (
        <div className="px-4 py-3.75" style={{ background: 'var(--surface-2)' }}>
            <div className="mb-2.5 font-mono text-[9px] uppercase tracking-[0.12em] text-faint">
                Edit metadata · {repo.gitUrl}
            </div>
            <div className="flex gap-3">
                <div className="flex-1">
                    <label className="mb-1.5 block text-[11.5px] font-medium text-dim">Display name</label>
                    <input
                        value={name}
                        onChange={(e) => setName(e.target.value)}
                        className="w-full rounded-md border border-border-2 bg-surface px-3 py-2.5 text-[13px] text-text outline-none transition focus:border-accent" />
                </div>
                <div className="w-48">
                    <label className="mb-1.5 block text-[11.5px] font-medium text-dim">Base branch</label>
                    <BranchPicker
                        orgId={orgId}
                        repoId={repo.id}
                        value={branch}
                        onChange={setBranch}
                        fallback={repo.defaultBranch} />
                </div>
                <div className="w-48">
                    <label className="mb-1.5 block text-[11.5px] font-medium text-dim">Branch prefix</label>
                    <input
                        value={branchPrefix}
                        onChange={(e) => setBranchPrefix(e.target.value)}
                        placeholder="feature/"
                        className="w-full rounded-md border border-border-2 bg-surface px-3 py-2.5 text-[13px] text-text outline-none transition focus:border-accent" />
                </div>
            </div>

            <div className="mt-3.5 flex flex-col gap-3 border-t border-dashed border-border-2 pt-3.5">
                <div className="w-48">
                    <label
                        htmlFor="repo-edit-merge-method"
                        className="mb-1.5 block text-[11.5px] font-medium text-dim"
                    >
                        Merge method
                    </label>
                    <select
                        id="repo-edit-merge-method"
                        data-testid="repo-edit-merge-method"
                        value={mergeMethod}
                        onChange={(e) => setMergeMethod(e.target.value as AutoMergeMethod)}
                        className="w-full rounded-md border border-border-2 bg-surface px-3 py-2.5 text-[13px] capitalize text-text outline-none transition focus:border-accent"
                    >
                        {AUTO_MERGE_METHODS.map((m) => (
                            <option key={m} value={m}>
                                {m}
                            </option>
                        ))}
                    </select>
                </div>

                <div className="flex items-center justify-between gap-2.5">
                    <div>
                        <label
                            htmlFor="repo-edit-delete-branch"
                            className="mb-0.5 block text-[11.5px] font-medium text-dim"
                        >
                            Delete branch after merge
                        </label>
                        <p className="text-[10.5px] leading-snug text-faint">
                            Removes the head branch once Atlas merges the PR.
                        </p>
                    </div>
                    <button
                        id="repo-edit-delete-branch"
                        type="button"
                        role="switch"
                        aria-checked={deleteBranch}
                        aria-label="Delete branch after merge"
                        data-testid="repo-edit-delete-branch"
                        onClick={() => setDeleteBranch((v) => !v)}
                        className="relative h-4.25 w-7.5 shrink-0 rounded-full border transition-colors"
                        style={{
                            background: deleteBranch ? 'var(--green)' : 'var(--surface-3)',
                            borderColor: deleteBranch ? 'var(--green)' : 'var(--border-2)',
                        }}
                    >
                        <span
                            className="absolute top-px left-px h-3.25 w-3.25 rounded-full bg-white transition-transform"
                            style={{
                                transform: deleteBranch ? 'translateX(13px)' : 'translateX(0)',
                                boxShadow: '0 1px 2px rgba(0, 0, 0, 0.25)',
                            }} />
                    </button>
                </div>
            </div>

            <div className="mt-3 flex gap-2.5">
                <button
                    type="button"
                    onClick={save}
                    disabled={updateState.isLoading}
                    className="flex items-center gap-1.5 rounded-md px-3.5 py-2 text-[12px] font-semibold text-white transition hover:brightness-105 disabled:opacity-75"
                    style={{ background: 'var(--accent)' }}
                >
                    {updateState.isLoading ? <Spinner className="h-2.75 w-2.75" /> : null}
                    {updateState.isLoading ? 'Saving…' : 'Save'}
                </button>
                <button
                    type="button"
                    onClick={onClose}
                    className="rounded-md border border-border-2 px-3.5 py-2 text-[12px] font-medium text-dim transition hover:bg-surface-2"
                >
                    Cancel
                </button>
            </div>
        </div>
    );
}
