"use client";

import { CheckCircle2, Lock, Plug, RefreshCw } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Markdown } from "./markdown";
import { useApproveMcpProposal } from "@/lib/api/job-queries";
import { useOrg } from "@/lib/api/me";
import { useMcpOAuthConnect, useMcpServers } from "@/lib/api/orgs";
import type { JobRef } from "@/lib/api/job-api";
import type { WebMcpProposalCard, WebMcpProposalServer } from "@/lib/api/types";

/** The secret header/env keys a server still needs after approval (declared by name, filled via a secret card). */
function secretSlots(s: WebMcpProposalServer): string[] {
  return [
    ...(s.headers ?? []).filter((h) => h.secret).map((h) => `header:${h.name}`),
    ...(s.env ?? []).filter((e) => e.secret).map((e) => `env:${e.name}`),
  ];
}

function endpoint(s: WebMcpProposalServer): string {
  return s.transport === "stdio" ? (s.command ?? "stdio") : (s.url ?? s.transport);
}

/**
 * One registered OAuth server row with its own inline Connect/Reconnect button. Each row owns its own
 * `useMcpOAuthConnect` instance so `busy`/`result` stay scoped to this server — connecting one server
 * never spins or mislabels another's button when a card proposes several OAuth servers.
 */
function OAuthServerRow({
  orgId,
  name,
  scope,
  connected,
  needsReauth,
  isOwner,
}: {
  orgId: string;
  name: string;
  scope: string;
  connected: boolean;
  needsReauth: boolean;
  isOwner: boolean;
}) {
  const oauth = useMcpOAuthConnect(orgId);
  return (
    <div className="flex flex-col gap-1">
      <div className="flex items-center gap-2">
        <Plug size={13} className="shrink-0 text-accent" />
        <span className="font-mono text-[12px] font-medium text-text">{name}</span>
        {connected ? (
          <span className="flex items-center gap-1 text-[11.5px] font-medium" style={{ color: "var(--green)" }}>
            <CheckCircle2 size={12} style={{ color: "var(--green)" }} />
            Connected
          </span>
        ) : needsReauth ? (
          <span className="text-[11.5px] font-medium text-amber">Needs re-auth</span>
        ) : (
          <span className="text-[11.5px] text-dim">Not connected</span>
        )}
        <div className="flex-1" />
        {isOwner ? (
          <Button
            size="sm"
            variant="soft"
            icon={connected || needsReauth ? <RefreshCw size={12} /> : <Plug size={12} />}
            loading={oauth.busy}
            loadingText="Connecting…"
            onClick={() => oauth.connect({ scope, name })}
          >
            {connected || needsReauth ? "Reconnect" : "Connect"}
          </Button>
        ) : null}
      </div>
      {oauth.result ? (
        <span className={`text-[11px] ${oauth.result.ok ? "text-green" : "text-red"}`}>
          {oauth.result.text}
        </span>
      ) : null}
    </div>
  );
}

/**
 * A stack-matched MCP-server recommendation the onboarding brain posed via `propose_mcp_servers`. The brain
 * never registers servers itself — the OWNER approves this card, which commits each server on the repo
 * (owner-only on the server). Secret slots are filled afterwards via the normal secure secret card; an
 * `oauth` server is instead connected right here (before or after approving) via the shared OAuth popup
 * flow. Once `approved_at` is set, renders the compact "registered" state. Value-free (server defs only).
 */
export function McpProposalCard({
  card,
  jobRef,
}: {
  card: WebMcpProposalCard;
  jobRef: JobRef;
}) {
  const approve = useApproveMcpProposal(jobRef);
  const org = useOrg(jobRef.orgId);
  const isOwner = org?.role === "owner";
  const oauth = useMcpOAuthConnect(jobRef.orgId);
  const { data: mcp } = useMcpServers(jobRef.orgId);
  const scopeOf = card.scope === "org" ? "org" : jobRef.repoId;
  const isRegisterCard = card.mode !== "remove";
  const oauthServers = isRegisterCard ? card.servers.filter((s) => s.authKind === "oauth") : [];
  const statusOf = (name: string) => mcp?.servers.find((s) => s.scope === scopeOf && s.name === name);

  if (card.approved_at != null) {
    const names = card.committed ?? card.servers.map((s) => s.name);
    return (
      <div className="anim-pop self-stretch overflow-hidden rounded-lg border border-border bg-surface">
        <div className="flex items-center gap-2.5 px-4 py-3">
          <CheckCircle2 size={15} style={{ color: "var(--green)" }} />
          <div className="min-w-0">
            <p className="text-[13px] font-medium text-text">
              MCP server{names.length === 1 ? "" : "s"} registered
            </p>
            <p className="truncate text-[12.5px] text-dim">
              {names.map((n) => (
                <span key={n} className="mr-1.5 font-mono">
                  {n}
                </span>
              ))}
            </p>
          </div>
        </div>
        {oauthServers.length > 0 ? (
          <div className="flex flex-col gap-2 border-t border-border bg-surface-2 px-4 py-2.5">
            {oauthServers.map((s) => {
              const status = statusOf(s.name);
              return (
                <OAuthServerRow
                  key={s.name}
                  orgId={jobRef.orgId}
                  name={s.name}
                  scope={scopeOf}
                  connected={status?.oauthConnected ?? false}
                  needsReauth={status?.needsReauth ?? false}
                  isOwner={isOwner}
                />
              );
            })}
          </div>
        ) : null}
      </div>
    );
  }

  return (
    <div className="anim-pop self-stretch overflow-hidden rounded-lg border border-border bg-surface">
      <div className="flex items-center gap-2.5 border-b border-border px-4 py-3">
        <Plug size={15} className="text-accent" />
        <span className="text-[13px] font-semibold text-text">
          Recommended MCP server{card.servers.length === 1 ? "" : "s"}
        </span>
        <div className="flex-1" />
        <span className="rounded-full border border-border px-2 py-0.5 font-mono text-[9.5px] text-dim">
          {card.servers.length} proposed
        </span>
      </div>

      <div className="flex flex-col gap-2.5 px-4 py-3">
        {card.servers.map((s) => {
          const slots = secretSlots(s);
          return (
            <div key={s.name} className="rounded-md border border-border bg-surface-2 px-3 py-2">
              <div className="flex items-center gap-2">
                <span className="font-mono text-[12.5px] font-semibold text-text">{s.name}</span>
                <span className="rounded-full border border-border px-1.5 py-0.5 text-[9.5px] uppercase text-dim">
                  {s.transport}
                </span>
                {s.authKind === "oauth" ? (
                  <span className="rounded-full border border-accent/40 px-1.5 py-0.5 text-[9.5px] uppercase text-accent">
                    oauth
                  </span>
                ) : slots.length > 0 ? (
                  <span className="rounded-full border border-border px-1.5 py-0.5 text-[9.5px] text-amber">
                    needs secret
                  </span>
                ) : null}
              </div>
              <p className="mt-0.5 truncate font-mono text-[11px] text-faint">{endpoint(s)}</p>
              {s.reason ? (
                <div className="mt-1 text-[12px] text-dim">
                  <Markdown>{s.reason}</Markdown>
                </div>
              ) : null}
            </div>
          );
        })}
        <p className="text-[11.5px] leading-snug text-dim">
          Approving registers {card.servers.length === 1 ? "this server" : "these servers"} on this repo.
          Servers marked <span className="text-amber">needs secret</span> then ask you for a credential
          through a secure field — the value never appears in the conversation.
          {oauthServers.length > 0 ? (
            <>
              {" "}
              Servers marked <span className="text-accent">oauth</span> need one more step — you'll
              authorize them right here after approving.
            </>
          ) : null}
        </p>
      </div>

      <div className="flex flex-col gap-2 border-t border-border bg-surface-2 px-4 py-3">
        {isOwner ? (
          <div className="flex flex-wrap items-center gap-2">
            {oauthServers.length === 1 ? (
              <Button
                size="sm"
                loading={approve.isPending || oauth.busy}
                loadingText={approve.isPending ? "Registering…" : "Connecting…"}
                onClick={async () => {
                  await approve.mutateAsync(card.requestId);
                  await oauth.connect({ scope: scopeOf, name: oauthServers[0].name });
                }}
              >
                Approve &amp; Connect
              </Button>
            ) : (
              <Button
                size="sm"
                loading={approve.isPending}
                loadingText="Registering…"
                onClick={() => approve.mutate(card.requestId)}
              >
                Approve &amp; register
              </Button>
            )}
            {approve.isError ? (
              <span className="text-[11.5px] text-red">Could not register the servers. Try again.</span>
            ) : null}
            {oauth.result ? (
              <span className={`text-[11.5px] ${oauth.result.ok ? "text-green" : "text-red"}`}>
                {oauth.result.text}
              </span>
            ) : null}
          </div>
        ) : (
          <div className="flex items-center gap-2 text-[11.5px] text-dim">
            <Lock size={13} />
            Only an owner can register MCP servers.
          </div>
        )}
      </div>
    </div>
  );
}
