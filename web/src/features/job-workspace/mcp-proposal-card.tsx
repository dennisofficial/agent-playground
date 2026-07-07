"use client";

import { CheckCircle2, Lock, Plug } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Markdown } from "./markdown";
import { useApproveMcpProposal } from "@/lib/api/job-queries";
import { useOrg } from "@/lib/api/me";
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
 * A stack-matched MCP-server recommendation the onboarding brain posed via `propose_mcp_servers`. The brain
 * never registers servers itself — the OWNER approves this card, which commits each server on the repo
 * (owner-only on the server). Secret slots are filled afterwards via the normal secure secret card. Once
 * `approved_at` is set, renders the compact "registered" state. Value-free (server defs only).
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
                {slots.length > 0 ? (
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
        </p>
      </div>

      <div className="flex flex-col gap-2 border-t border-border bg-surface-2 px-4 py-3">
        {isOwner ? (
          <div className="flex flex-wrap items-center gap-2">
            <Button
              size="sm"
              loading={approve.isPending}
              loadingText="Registering…"
              onClick={() => approve.mutate(card.requestId)}
            >
              Approve &amp; register
            </Button>
            {approve.isError ? (
              <span className="text-[11.5px] text-red">Could not register the servers. Try again.</span>
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
