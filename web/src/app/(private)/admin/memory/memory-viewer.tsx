'use client';

import { useRouter } from 'next/navigation';
import { useState, useTransition } from 'react';
import type { FactView, TenantView } from '@/lib/admin-api';
import { FactRow } from './fact-row';
import { TIER_LABEL, TIER_ORDER, type Tier } from './tiers';

// ── Shared style constants ────────────────────────────────────────────────────────────────────────
const inputCls =
  'rounded-md border border-zinc-300 bg-transparent px-3 py-2 text-sm text-black outline-none focus:border-zinc-500 dark:border-zinc-700 dark:text-zinc-50';

// ── Types ─────────────────────────────────────────────────────────────────────────────────────────

interface TierCounts {
  active: number;
  forgotten: number;
}

interface MemoryViewerProps {
  tenants: TenantView[];
  selectedTeamId: string;
  facts: FactView[];
  truncated: boolean;
  total: number;
}

// ── Component ─────────────────────────────────────────────────────────────────────────────────────

export function MemoryViewer({
  tenants,
  selectedTeamId,
  facts,
  truncated,
  total,
}: MemoryViewerProps) {
  const router = useRouter();
  const [isPending, startTransition] = useTransition();

  // Derive sorted list of distinct agent ids from loaded facts (bot + private facts only have botId).
  const agents = [...new Set(facts.flatMap((f) => (f.botId !== null ? [f.botId] : [])))].sort();

  const [selectedAgent, setSelectedAgent] = useState<string | null>(
    agents[0] ?? null,
  );
  const [selectedTier, setSelectedTier] = useState<Tier>('project');
  const [showForgotten, setShowForgotten] = useState(false);
  const [query, setQuery] = useState('');

  // ── Per-tier counts for tab hints ───────────────────────────────────────────

  // Counts of active/forgotten facts per tier, filtered to the selected agent where relevant.
  const tierCounts: Record<Tier, TierCounts> = {
    project: { active: 0, forgotten: 0 },
    team: { active: 0, forgotten: 0 },
    bot: { active: 0, forgotten: 0 },
    private: { active: 0, forgotten: 0 },
  };

  for (const f of facts) {
    const isAgentFact = f.tier === 'bot' || f.tier === 'private';
    if (isAgentFact && f.botId !== selectedAgent) continue;
    const bucket = tierCounts[f.tier];
    if (f.deletedAt !== null) {
      bucket.forgotten += 1;
    } else {
      bucket.active += 1;
    }
  }

  // ── Visible facts ────────────────────────────────────────────────────────────

  // Filter by tier + agent, then by forgotten toggle, then by search query.
  // Active facts first, forgotten after; each group sorted by updatedAt desc.
  const tierFacts = facts.filter((f) => {
    if (f.tier !== selectedTier) return false;
    if ((f.tier === 'bot' || f.tier === 'private') && f.botId !== selectedAgent)
      return false;
    return true;
  });

  const lq = query.trim().toLowerCase();

  const activeFacts = tierFacts
    .filter((f) => f.deletedAt === null)
    .filter((f) => !lq || f.content.toLowerCase().includes(lq))
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));

  const forgottenFacts = showForgotten
    ? tierFacts
        .filter((f) => f.deletedAt !== null)
        .filter((f) => !lq || f.content.toLowerCase().includes(lq))
        .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
    : [];

  const visibleFacts = [...activeFacts, ...forgottenFacts];

  // ── Event handlers ────────────────────────────────────────────────────────────

  function handleTeamChange(teamId: string) {
    startTransition(() => {
      router.push(`/admin/memory?team=${encodeURIComponent(teamId)}`);
    });
  }

  function handleAgentSelect(agent: string) {
    setSelectedAgent(agent);
    // Switch to the first non-empty tier for this agent.
    const firstNonEmpty = TIER_ORDER.find((t) => {
      const c = tierCounts[t];
      return c.active + c.forgotten > 0;
    });
    if (firstNonEmpty) setSelectedTier(firstNonEmpty);
    setQuery('');
  }

  function handleTierSelect(tier: Tier) {
    setSelectedTier(tier);
    setQuery('');
  }

  // ── Render ────────────────────────────────────────────────────────────────────

  const selectedTenant = tenants.find((t) => t.id === selectedTeamId);

  return (
    <div>
      {/* Workspace picker */}
      <div className="mb-6 flex items-center gap-3">
        <label
          htmlFor="workspace-select"
          className="text-sm font-medium text-zinc-700 dark:text-zinc-300"
        >
          Workspace
        </label>
        <select
          id="workspace-select"
          value={selectedTeamId}
          onChange={(e) => handleTeamChange(e.target.value)}
          disabled={isPending}
          className={`${inputCls} min-w-[180px] disabled:opacity-60`}
        >
          {tenants.map((t) => (
            <option key={t.id} value={t.id}>
              {t.name}
            </option>
          ))}
        </select>
        {isPending && (
          <span className="text-xs text-zinc-400 dark:text-zinc-500">Loading…</span>
        )}
      </div>

      {/* Truncation notice */}
      {truncated && (
        <p className="mb-4 text-xs text-zinc-500 dark:text-zinc-400">
          Showing first {facts.length.toLocaleString()} of {total.toLocaleString()} facts in{' '}
          <strong>{selectedTenant?.name ?? selectedTeamId}</strong>. Increase the cap to see more.
        </p>
      )}

      <div className="flex gap-6">
        {/* Agent sidebar */}
        <aside className="w-44 shrink-0">
          <p className="mb-2 text-xs font-semibold uppercase tracking-wide text-zinc-400 dark:text-zinc-500">
            Agents
          </p>
          {agents.length === 0 ? (
            <p className="text-sm text-zinc-500 dark:text-zinc-400">
              No agent facts recorded yet.
            </p>
          ) : (
            <ul className="flex flex-col gap-1">
              {agents.map((agent) => (
                <li key={agent}>
                  <button
                    type="button"
                    onClick={() => handleAgentSelect(agent)}
                    className={`w-full rounded-md px-3 py-2 text-left text-sm font-medium capitalize transition-colors ${
                      selectedAgent === agent
                        ? 'bg-zinc-900 text-white dark:bg-zinc-50 dark:text-black'
                        : 'text-zinc-700 hover:bg-zinc-100 dark:text-zinc-300 dark:hover:bg-zinc-900'
                    }`}
                  >
                    {agent}
                  </button>
                </li>
              ))}
            </ul>
          )}
        </aside>

        {/* Main content */}
        <div className="min-w-0 flex-1">
          {/* Tier tabs */}
          <div className="flex items-end gap-1 border-b border-zinc-200 dark:border-zinc-800">
            {TIER_ORDER.map((tier) => {
              const counts = tierCounts[tier];
              const isActive = tier === selectedTier;
              return (
                <button
                  key={tier}
                  type="button"
                  onClick={() => handleTierSelect(tier)}
                  className={`flex items-center gap-1.5 rounded-t px-3 py-2 text-sm transition-colors ${
                    isActive
                      ? 'border-b-2 border-black font-semibold text-black dark:border-zinc-50 dark:text-zinc-50'
                      : 'text-zinc-500 hover:text-zinc-700 dark:text-zinc-400 dark:hover:text-zinc-200'
                  }`}
                >
                  <span>{TIER_LABEL[tier]}</span>
                  <span
                    className={`rounded-full px-1.5 py-0.5 text-xs ${
                      isActive
                        ? 'bg-zinc-200 text-zinc-700 dark:bg-zinc-700 dark:text-zinc-200'
                        : 'bg-zinc-100 text-zinc-500 dark:bg-zinc-800 dark:text-zinc-400'
                    }`}
                  >
                    {counts.active}
                  </span>
                  {counts.forgotten > 0 && (
                    <span className="text-xs text-zinc-400 dark:text-zinc-500">
                      +{counts.forgotten} forgotten
                    </span>
                  )}
                </button>
              );
            })}
          </div>

          {/* Toolbar: search + forgotten toggle */}
          <div className="my-3 flex items-center gap-3">
            <input
              type="search"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder={`Search ${selectedAgent ?? selectedTenant?.name ?? 'workspace'}'s memories…`}
              className={`${inputCls} flex-1`}
            />
            <label className="flex cursor-pointer items-center gap-2 text-sm text-zinc-600 dark:text-zinc-300">
              <input
                type="checkbox"
                checked={showForgotten}
                onChange={(e) => setShowForgotten(e.target.checked)}
                className="rounded"
              />
              Show forgotten
              {tierCounts[selectedTier].forgotten > 0 && (
                <span className="text-xs text-zinc-400 dark:text-zinc-500">
                  (+{tierCounts[selectedTier].forgotten})
                </span>
              )}
            </label>
          </div>

          {/* Fact list */}
          {selectedAgent === null && (agents.length > 0 || tierCounts[selectedTier].active + tierCounts[selectedTier].forgotten === 0) ? (
            <AgentEmptyState />
          ) : visibleFacts.length === 0 && lq ? (
            <SearchEmptyState query={query} onClear={() => setQuery('')} />
          ) : visibleFacts.length === 0 ? (
            <TierEmptyState tier={selectedTier} agent={selectedAgent} />
          ) : (
            <ul className="flex flex-col gap-2">
              {visibleFacts.map((f) => (
                <li key={f.id}>
                  <FactRow fact={f} />
                </li>
              ))}
            </ul>
          )}
        </div>
      </div>
    </div>
  );
}

// ── Empty / error states ──────────────────────────────────────────────────────────────────────────

function AgentEmptyState() {
  return (
    <p className="py-8 text-center text-sm text-zinc-500 dark:text-zinc-400">
      Select an agent from the sidebar.
    </p>
  );
}

function TierEmptyState({ tier, agent }: { tier: Tier; agent: string | null }) {
  if (agent === null) {
    return (
      <p className="py-8 text-center text-sm text-zinc-500 dark:text-zinc-400">
        No {TIER_LABEL[tier].toLowerCase()} memories yet.
      </p>
    );
  }
  return (
    <p className="py-8 text-center text-sm text-zinc-500 dark:text-zinc-400">
      No {TIER_LABEL[tier].toLowerCase()} memories recorded for{' '}
      <span className="font-medium capitalize">{agent}</span> yet.
    </p>
  );
}

function SearchEmptyState({
  query,
  onClear,
}: {
  query: string;
  onClear: () => void;
}) {
  return (
    <p className="py-8 text-center text-sm text-zinc-500 dark:text-zinc-400">
      No memories matching &quot;{query}&quot;.{' '}
      <button
        type="button"
        onClick={onClear}
        className="underline hover:text-zinc-700 dark:hover:text-zinc-200"
      >
        Clear search
      </button>
    </p>
  );
}
