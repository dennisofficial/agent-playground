"use client";

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import {
  Check,
  ChevronDown,
  FileKey,
  GitBranch,
  KeyRound,
  Plug,
  Settings as SettingsIcon,
  Users,
} from "lucide-react";
import { cn } from "@/lib/cn";
import { ROUTES, type SettingsSection } from "@/lib/routes";
import { BrandLockup } from "@/components/ui/brand";
import { AccountMenu } from "@/features/shell/components/account-menu";
import { useOrg, useOrgs, type OrgSummary } from "@/lib/api/me";
import { orgSwatch, orgInitials, roleLabel } from "@/lib/org-display";
import { GeneralSection } from "./general-section";
import { CredentialsSection } from "./credentials-section";
import { WorktreeSecretsSection } from "./worktree-secrets-section";
import { McpSection } from "./mcp-section";
import { MembersSection } from "./members-section";
import { ReposSection } from "./repos-section";

const NAV: { id: SettingsSection; label: string; icon: typeof SettingsIcon }[] =
  [
    { id: "general", label: "General", icon: SettingsIcon },
    { id: "credentials", label: "Credentials", icon: KeyRound },
    { id: "worktree-secrets", label: "Worktree secrets", icon: FileKey },
    { id: "mcp-servers", label: "MCP servers", icon: Plug },
    { id: "members", label: "Members", icon: Users },
    { id: "repos", label: "Repos", icon: GitBranch },
  ];

/** The Org & Settings screen — own top bar + a section nav (General / Credentials / Members). */
export function OrgSettings({
  orgId,
  initialSection,
}: {
  orgId: string;
  initialSection: SettingsSection;
}) {
  const { orgs, isLoading } = useOrgs();
  const org = useOrg(orgId);
  const router = useRouter();
  const [section, setSection] = useState<SettingsSection>(initialSection);

  return (
    <>
      {/* Top bar */}
      <header
        className="flex h-[52px] shrink-0 items-center gap-3.5 border-b border-border px-4 backdrop-blur"
        style={{
          background: "color-mix(in srgb, var(--panel) 82%, transparent)",
        }}
      >
        <Link href={ROUTES.workspace()} aria-label="Back to workspace">
          <BrandLockup size="sm" />
        </Link>
        <span
          className="h-[18px] w-px"
          style={{ background: "var(--border-2)" }}
        />
        <div className="flex items-center gap-2 font-mono text-[11px] text-dim">
          <OrgSwitcher
            orgs={orgs}
            currentId={orgId}
            currentName={org?.name}
            onSwitch={(id) => {
              if (id !== orgId) router.push(ROUTES.orgSettings(id, section));
            }}
          />
          <span className="text-border-2">/</span>
          <span className="text-text">Settings</span>
        </div>
        <div className="flex-1" />
        {org?.role === "member" ? (
          <span className="rounded-full border border-border-2 bg-surface-2 px-2.5 py-[3px] font-mono text-[9px] text-dim">
            member
          </span>
        ) : null}
        <AccountMenu />
      </header>

      <div className="flex min-h-0 flex-1">
        {/* Settings nav */}
        <nav
          className="flex w-[228px] shrink-0 flex-col gap-0.5 border-r border-border px-3 py-4"
          style={{
            background: "color-mix(in srgb, var(--panel) 60%, transparent)",
          }}
        >
          <div className="flex items-center gap-2.5 px-2 pb-3 pt-1.5">
            <span
              className="flex h-[30px] w-[30px] shrink-0 items-center justify-center rounded-lg font-disp text-[14px] font-semibold text-white"
              style={{ background: org ? orgSwatch() : "var(--border-2)" }}
            >
              {org ? orgInitials(org.name) : "·"}
            </span>
            <div className="min-w-0">
              <div className="truncate text-[12.5px] font-semibold text-text">
                {org?.name ?? "—"}
              </div>
              <div
                className="font-mono text-[8.5px]"
                style={{
                  color:
                    org?.status === "active" ? "var(--green)" : "var(--faint)",
                }}
              >
                {org?.status ?? "—"}
              </div>
            </div>
          </div>
          <div className="px-2 pb-1.5 pt-1 font-mono text-[9px] tracking-[0.16em] text-faint">
            ORGANIZATION
          </div>
          {NAV.map(({ id, label, icon: Icon }) => {
            const on = section === id;
            return (
              <button
                key={id}
                type="button"
                onClick={() => setSection(id)}
                className={cn(
                  "flex items-center gap-2.5 rounded-md px-2.5 py-2 text-[12.5px] font-medium transition",
                  on ? "text-accent" : "text-dim hover:bg-surface-2",
                )}
                style={
                  on
                    ? {
                        background: "var(--accent-soft)",
                        boxShadow: "inset 0 0 0 1px var(--accent-line)",
                      }
                    : undefined
                }
              >
                <Icon size={15} />
                {label}
              </button>
            );
          })}
        </nav>

        {/* Content */}
        <div className="min-w-0 flex-1 overflow-y-auto bg-surface">
          <div className="max-w-[640px] px-9 py-8 pb-16">
            {isLoading ? (
              <p className="text-[13px] text-faint">Loading…</p>
            ) : !org ? (
              <div className="rounded-lg border border-dashed border-border-2 px-6 py-14 text-center">
                <h2 className="text-[15px] font-semibold text-text">
                  Organization not found
                </h2>
                <p className="mx-auto mt-1.5 max-w-sm text-[13px] text-dim">
                  This organization doesn’t exist or you don’t have access to
                  it.
                </p>
                <Link
                  href={ROUTES.workspace()}
                  className="mt-4 inline-block text-[12.5px] font-medium text-accent"
                >
                  ← Back to workspace
                </Link>
              </div>
            ) : section === "general" ? (
              <GeneralSection org={org} />
            ) : section === "credentials" ? (
              <CredentialsSection orgId={org.id} />
            ) : section === "worktree-secrets" ? (
              <WorktreeSecretsSection orgId={org.id} role={org.role} />
            ) : section === "mcp-servers" ? (
              <McpSection orgId={org.id} role={org.role} />
            ) : section === "repos" ? (
              <ReposSection
                orgId={org.id}
                orgName={org.name}
                role={org.role}
                onNavigate={setSection}
              />
            ) : (
              <MembersSection orgId={org.id} orgName={org.name} />
            )}
          </div>
        </div>
      </div>
    </>
  );
}

/**
 * Breadcrumb org switcher — turns the `OrgName / Settings` crumb into a dropdown so the operator can hop
 * between their orgs' settings without going back to the shell. Selecting an org navigates to that org's
 * settings route preserving the active `?section`; the page is keyed by orgId so it remounts onto the new
 * org (its left-nav header + tab content follow). Lists every org the operator belongs to, current checked.
 */
function OrgSwitcher({
  orgs,
  currentId,
  currentName,
  onSwitch,
}: {
  orgs: OrgSummary[];
  currentId: string;
  currentName: string | undefined;
  onSwitch: (orgId: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    function onDoc(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node))
        setOpen(false);
    }
    document.addEventListener("mousedown", onDoc);
    return () => document.removeEventListener("mousedown", onDoc);
  }, []);

  return (
    <div className="relative" ref={ref}>
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        className="flex items-center gap-1.5 rounded-[5px] border px-1.5 py-[3px] transition"
        style={
          open
            ? {
                background: "var(--accent-soft)",
                borderColor: "var(--accent-line)",
              }
            : { background: "var(--surface)", borderColor: "var(--border)" }
        }
      >
        <span
          className="h-2 w-2 shrink-0 rounded-[2px]"
          style={{ background: currentName ? orgSwatch() : "var(--faint)" }}
        />
        <span className="text-text">{currentName ?? "Organization"}</span>
        <ChevronDown
          size={11}
          className={cn(
            "shrink-0 transition",
            open ? "text-accent" : "text-faint",
          )}
          style={open ? { transform: "rotate(180deg)" } : undefined}
        />
      </button>

      {open ? (
        <div
          className="absolute left-0 top-[calc(100%+6px)] z-50 w-[236px] overflow-hidden rounded-md border border-border bg-panel py-1"
          style={{ boxShadow: "var(--shadow-menu)" }}
        >
          <div className="px-3 pb-1 pt-1.5 font-mono text-[8.5px] tracking-[0.12em] text-faint">
            SWITCH ORG SETTINGS
          </div>
          {orgs.map((o) => {
            const on = o.id === currentId;
            return (
              <button
                key={o.id}
                type="button"
                onClick={() => {
                  setOpen(false);
                  onSwitch(o.id);
                }}
                className={cn(
                  "flex w-full items-center gap-2.5 px-3 py-1.5 text-left transition",
                  on ? "bg-surface-2" : "hover:bg-surface-2",
                )}
              >
                <span
                  className="h-[9px] w-[9px] shrink-0 rounded-[2px]"
                  style={{ background: orgSwatch() }}
                />
                <span className="flex min-w-0 flex-1 flex-col leading-tight">
                  <span
                    className={cn(
                      "truncate text-[12px] text-text",
                      on ? "font-semibold" : "font-medium",
                    )}
                  >
                    {o.name}
                  </span>
                  <span className="font-mono text-[9px] text-faint">
                    {roleLabel(o.role)} · {o.status}
                  </span>
                </span>
                {on ? (
                  <Check size={13} className="shrink-0 text-accent" />
                ) : null}
              </button>
            );
          })}
        </div>
      ) : null}
    </div>
  );
}
