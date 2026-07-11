"use client";

import { use } from "react";
import { useOrg } from "@/lib/api/me";
import { McpSection } from "@/features/settings/components/mcp-section";

export default function McpServersSettingsPage({
  params,
}: {
  params: Promise<{ orgId: string }>;
}) {
  const { orgId } = use(params);
  const org = useOrg(orgId);
  if (!org) return null;
  return <McpSection orgId={org.id} role={org.role} />;
}
