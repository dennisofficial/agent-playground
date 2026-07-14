"use client";

import { use } from "react";
import { useOrg } from "@/lib/api/me";
import { AutomationSection } from "@/features/settings/components/automation-section";

export default function AutomationSettingsPage({
  params,
}: {
  params: Promise<{ orgId: string }>;
}) {
  const { orgId } = use(params);
  const org = useOrg(orgId);
  if (!org) return null;
  return <AutomationSection org={org} />;
}
