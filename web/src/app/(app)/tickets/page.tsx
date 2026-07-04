"use client";

import { useEffect } from "react";
import { useRouter } from "next/navigation";
import { ROUTES } from "@/lib/routes";
import { useAllRepos } from "@/lib/api/tickets-queries";
import { Spinner } from "@/components/ui/spinner";

/**
 * Tickets index — no repo selected yet. Auto-routes to the first connected repo's board (the sidebar is
 * already there to switch); if there are none, prompts to connect one.
 */
export default function TicketsIndexPage() {
  const router = useRouter();
  const { repos, isLoading } = useAllRepos();
  const first = repos[0];

  useEffect(() => {
    if (first) router.replace(ROUTES.tickets(first.orgId, first.repo.id));
  }, [first, router]);

  if (isLoading || first) {
    return (
      <div className="flex h-full items-center justify-center">
        <Spinner className="h-5 w-5 text-faint" />
      </div>
    );
  }

  return (
    <div className="flex h-full items-center justify-center px-6">
      <div className="max-w-[380px] text-center">
        <h2 className="font-disp text-[16px] font-semibold text-text">
          No repositories yet
        </h2>
        <p className="mt-2 text-[12.5px] leading-relaxed text-dim">
          Connect a repo in an organization&apos;s settings to get a tickets
          board.
        </p>
      </div>
    </div>
  );
}
